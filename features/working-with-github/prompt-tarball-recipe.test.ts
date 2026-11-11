import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const prompt = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "prompt.md"),
  "utf-8"
);

const tarballRecipe = [...prompt.matchAll(/```bash[^\n]*\n([\s\S]*?)```/g)]
  .map((match) => (match[1] ?? "").trim())
  .find((block) => block.includes("/tarball/"));

const archive = (): Uint8Array<ArrayBuffer> => {
  const source = mkdtempSync(join(tmpdir(), "wwg-tarball-source-"));
  try {
    Bun.spawnSync(["mkdir", "-p", join(source, "acme-widgets-abc", "src")]);
    Bun.spawnSync([
      "sh",
      "-c",
      `printf 'export const a = 1;\\n' > '${join(source, "acme-widgets-abc", "src", "a.ts")}'`,
    ]);
    const tar = Bun.spawnSync(["tar", "-cf", "-", "-C", source, "acme-widgets-abc"]);
    return Bun.gzipSync(new Uint8Array(tar.stdout));
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
};

type FirstResponse = "short" | "cut";

const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

const runRecipeAgainst = async (first: FirstResponse) => {
  const bytes = archive();
  const half = bytes.slice(0, Math.floor(bytes.length / 2));
  const statuses: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: (request, bunServer) => {
      const attempt = statuses.length;
      statuses.push(new URL(request.url).pathname);
      if (attempt > 0) {
        return new Response(bytes);
      }
      if (first === "short") {
        return new Response(half);
      }
      bunServer.timeout(request, 1);
      return new Response(
        new ReadableStream({
          start: (controller) => {
            controller.enqueue(half);
          },
        })
      );
    },
  });
  const work = mkdtempSync(join(tmpdir(), "wwg-tarball-recipe-"));
  scratch.push(work);
  const dir = join(work, "tree");
  const command = (tarballRecipe ?? "")
    .replaceAll("https://api.github.com", `http://127.0.0.1:${server.port}`)
    .replaceAll("{owner}", "acme")
    .replaceAll("{repo}", "widgets")
    .replaceAll("{ref}", "abc")
    .replaceAll("{dir}", dir);
  try {
    const child = Bun.spawn(["bash", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stderr, dir, requests: statuses };
  } finally {
    server.stop(true);
  }
};

describe("the prompt's whole-tree tarball recipe", () => {
  test("is one fenced bash block that names the tarball endpoint", () => {
    expect(tarballRecipe).toContain(
      "https://api.github.com/repos/{owner}/{repo}/tarball/{ref}"
    );
  });

  test.each([
    ["short", "an archive that ends cleanly at half its length", "gzip"],
    ["cut", "a connection dropped halfway through the archive", "curl: (18)"],
  ] as const)(
    "recovers from %s (%s) and extracts the whole tree",
    async (first, _how, firstFailure) => {
      const run = await runRecipeAgainst(first);
      expect(run.code).toBe(0);
      expect(run.stderr).toContain(firstFailure);
      expect(run.requests).toHaveLength(2);
      expect(
        readFileSync(join(run.dir, "acme-widgets-abc", "src", "a.ts"), "utf-8")
      ).toBe("export const a = 1;\n");
      expect(await Bun.file(`${run.dir}.tgz`).exists()).toBe(false);
    },
    { timeout: 60_000 }
  );
});

// The ambient "Read a file" recipe was `curl -sL …/contents/{path}?ref={ref}`.
// curl reads `[` and `]` in a URL as a glob range, so a web routing path
// (vercel/next.js `examples/i18n-routing/app/[lang]/page.tsx`) stopped with
// exit 3 `bad range in URL`, and `-s` hid even that: the file read as empty.
// A missing file printed GitHub's `Not Found` JSON with exit 0, as if it
// were the file's content.
describe("the read-a-file recipe reads bracketed paths and fails on a missing file", () => {
  const recipe = /- Read a file: `([^`]+)`/u.exec(prompt)?.[1] ?? "";

  const served = ["app/[lang]/page.tsx", "app/routes/notes.$noteId.tsx"];

  const read = async (path: string, ref = "main") => {
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        return served.includes(decodeURIComponent(url.pathname).replace("/repos/acme/widgets/contents/", "")) &&
          url.searchParams.get("ref") === ref
          ? new Response("export default function Page() {}\n")
          : Response.json({ message: "Not Found" }, { status: 404 });
      },
    });
    try {
      const command = recipe
        .replace("https://api.github.com", `http://127.0.0.1:${server.port}`)
        .replace("{owner}/{repo}", "acme/widgets")
        .replace("{path}", () => path)
        .replace("{ref}", () => ref);
      const proc = Bun.spawn(["bash", "-c", command], { stderr: "pipe", stdout: "pipe" });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code: await proc.exited, err, out };
    } finally {
      await server.stop(true);
    }
  };

  test("the recipe is in the prompt", () => {
    expect(recipe).toContain("/contents/{path}");
  });

  test("a path with [ and ] in it is read", async () => {
    expect(await read("app/[lang]/page.tsx")).toMatchObject({ code: 0, out: "export default function Page() {}\n" });
  });

  // GitHub reads a raw `+` in the query string as a space, as any form
  // decoder does: `?ref=400.0.2+4.0.3` (a real alexcrichton/openssl-src-rs
  // tag) answered 404 "No commit found for the ref 400.0.2 4.0.3". A `#`
  // cut the URL there and an `&` started a new parameter.
  for (const ref of ["400.0.2+4.0.3", "fix#12", "a&b"]) {
    test(`a ref with ${ref.replace(/[^+#&]/gu, "")} in it is read`, async () => {
      expect(await read("app/[lang]/page.tsx", ref)).toMatchObject({ code: 0, out: "export default function Page() {}\n" });
    });
  }

  // Remix and TanStack Router name route files with a `$` (remix-run/indie-stack
  // `app/routes/notes.$noteId.tsx`). The URL was double-quoted, so bash
  // expanded `$noteId` to nothing and curl asked for `notes..tsx`: a 404.
  test("a path with a $ in it is read, never expanded by the shell", async () => {
    expect(await read("app/routes/notes.$noteId.tsx")).toMatchObject({ code: 0, out: "export default function Page() {}\n" });
  });

  test("a missing file fails and says so instead of printing the 404 body", async () => {
    const result = await read("app/missing.tsx");
    expect(result.code).not.toBe(0);
    expect(result.out).not.toContain("Not Found");
    expect(result.err).toContain("404");
  });
});
