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
  const recipeLine = /- Read a file: .*/u.exec(prompt)?.[0] ?? "";
  const recipe = /- Read a file: `([^`]+)`/u.exec(prompt)?.[1] ?? "";

  const served = [
    "app/[lang]/page.tsx",
    "app/routes/notes.$noteId.tsx",
    "pages/New to Logseq%3F.md",
    "notes/What is DXF?.md",
    "docs/a b#c's 100%.md",
  ];

  // The prompt's own "Write a `%` … as `%25` first, then a space as `%20` …"
  // table, applied in the order it gives, the way an agent follows it.
  const encodingTable = [
    ...(/Write a .*?`%[0-9A-F]{2}`\./u.exec(recipeLine)?.[0] ?? "").matchAll(
      /a (?:`(.)`|space)[^`]*? as `(%[0-9A-F]{2})`/gu
    ),
  ].map((match) => [match[1] ?? " ", match[2] ?? ""] as const);
  const encodePath = (path: string): string =>
    encodingTable.reduce((encoded, [raw, escaped]) => encoded.replaceAll(raw, escaped), path);

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

  // GitHub decodes the path once. Logseq graphs store a page title's `?` as a
  // literal `%3F` (logseq/docs `pages/New to Logseq%3F.md`, ~95k such paths on
  // GitHub), so it must go as `%253F`: with no `%` rule it read as
  // `New to Logseq?.md` and 404'd. A raw `?` started the query string.
  for (const path of served.slice(2)) {
    test(`${JSON.stringify(path)}, encoded as the prompt says, is read`, async () => {
      expect(await read(encodePath(path))).toMatchObject({ code: 0, out: "export default function Page() {}\n" });
    });
  }

  test("a missing file fails and says so instead of printing the 404 body", async () => {
    const result = await read("app/missing.tsx");
    expect(result.code).not.toBe(0);
    expect(result.out).not.toContain("Not Found");
    expect(result.err).toContain("404");
  });
});

// The tarball recipe's URL was unquoted with a raw `{ref}`. A `#` is legal in a
// branch name, and curl reads it as a fragment: with branches `wwg-probe` and
// `wwg-probe#fix` on OpenRouterLabs/ori-feature-catalog, the recipe downloaded
// `wwg-probe` without a word (live). Unquoted, the shell also expanded a `$` and
// backgrounded the command at a `&`. The URL is now single-quoted, and the ref
// is encoded by the prompt's own rule before it is substituted.
describe("the tarball recipe sends the whole ref", () => {
  const bullet = /- Get a whole tree to grep\..*/u.exec(prompt)?.[0] ?? "";
  const encodeRef = (ref: string): string =>
    ref.replaceAll("%", "%25").replaceAll("#", "%23").replaceAll("'", "%27");

  test("the prose names the ref encoding the substitution below applies", () => {
    expect(bullet).toContain("write a `%` in it as `%25` first, then a `#` as `%23` and a `'` as `%27`");
  });

  test.each(["wwg-probe#fix", "a$HOME&b", "100%done", "it's"])(
    "asks for %p, not a cut or expanded ref",
    async (ref) => {
      const asked: string[] = [];
      const bytes = archive();
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
          asked.push(decodeURIComponent(new URL(request.url).pathname));
          return new Response(bytes);
        },
      });
      const work = mkdtempSync(join(tmpdir(), "wwg-tarball-ref-"));
      scratch.push(work);
      const dir = join(work, "tree");
      const command = (tarballRecipe ?? "")
        .replaceAll("https://api.github.com", `http://127.0.0.1:${server.port}`)
        .replaceAll("{owner}", "acme")
        .replaceAll("{repo}", "widgets")
        .replaceAll("{ref}", () => encodeRef(ref))
        .replaceAll("{dir}", dir);
      try {
        const child = Bun.spawn(["bash", "-c", command], { stdout: "pipe", stderr: "pipe" });
        expect(await child.exited).toBe(0);
        expect(asked).toEqual([`/repos/acme/widgets/tarball/${ref}`]);
      } finally {
        server.stop(true);
      }
    },
    { timeout: 60_000 }
  );
});

// The contents API does not follow a symbolic link: goinfinite/os commits
// `AGENTS.md` as a link to `.agents/AGENTS.md`, and the raw read printed that
// one line as the file (live), whose JSON form says `"type": "symlink"`. The
// prompt's check reads the JSON form and prints the path to read instead.
describe("the read-a-file symlink check names the file a link points to", () => {
  const check = [...prompt.matchAll(/```bash[^\n]*\n([\s\S]*?)```/g)]
    .map((match) => (match[1] ?? "").trim())
    .find((block) => block.includes('"symlink"'));

  const answer = async (entry: unknown) => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(entry) });
    try {
      const command = (check ?? "")
        .replace("https://api.github.com", `http://127.0.0.1:${server.port}`)
        .replace("{owner}/{repo}", "acme/widgets")
        .replace("{path}", "AGENTS.md")
        .replace("{ref}", "main");
      const child = Bun.spawn(["bash", "-c", command], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(child.stdout).text();
      return { code: await child.exited, out: out.trim() };
    } finally {
      await server.stop(true);
    }
  };

  test("the check is in the prompt", () => {
    expect(check).toContain("/contents/{path}");
  });

  test.each([
    [{ type: "symlink", path: "AGENTS.md", target: ".agents/AGENTS.md" }, ".agents/AGENTS.md"],
    [{ type: "symlink", path: "docs/AGENTS.md", target: "../.agents/AGENTS.md" }, ".agents/AGENTS.md"],
    [{ type: "symlink", path: "pkg/a/CLAUDE.md", target: "../b/./CLAUDE.md" }, "pkg/b/CLAUDE.md"],
    [{ type: "symlink", path: "AGENTS.md", target: "../shared/AGENTS.md" }, "AGENTS.md links out of the repository, to ../shared/AGENTS.md"],
    [{ type: "symlink", path: "AGENTS.md", target: "/etc/agents.md" }, "AGENTS.md links out of the repository, to /etc/agents.md"],
    [{ type: "file", path: "AGENTS.md", content: "" }, ""],
  ])("%p prints %p", async (entry, expected) => {
    expect(await answer(entry)).toEqual({ code: 0, out: expected });
  });
});
