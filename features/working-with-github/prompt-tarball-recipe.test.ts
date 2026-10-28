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
