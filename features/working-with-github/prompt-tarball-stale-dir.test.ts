import { afterEach, describe, expect, test } from "bun:test";

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The whole-tree tarball recipe promised its last command "fails when nothing
// was extracted", but it only checked that {dir} was non-empty. Re-fetching
// into a {dir} that already held an earlier extract (a newer ref, a refresh
// after a merge) exited 0 after all three downloads failed, so the agent read
// the OLD tree as the current source.

const prompt = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "prompt.md"),
  "utf-8"
);

const recipe = [...prompt.matchAll(/```bash[^\n]*\n([\s\S]*?)```/g)]
  .map((match) => (match[1] ?? "").trim())
  .find((block) => block.includes("/tarball/"));

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

const goodArchive = (work: string): Uint8Array<ArrayBuffer> => {
  const source = join(work, "source");
  mkdirSync(join(source, "acme-widgets-new"), { recursive: true });
  writeFileSync(join(source, "acme-widgets-new", "a.ts"), "new\n");
  const tar = Bun.spawnSync(["tar", "-cf", "-", "-C", source, "acme-widgets-new"]);
  return new Uint8Array(Bun.gzipSync(new Uint8Array(tar.stdout)));
};

const runInto = async (serve: "junk" | "good") => {
  const work = mkdtempSync(join(tmpdir(), "wwg-tarball-stale-"));
  scratch.push(work);
  const dir = join(work, "tree");
  mkdirSync(join(dir, "acme-widgets-old"), { recursive: true });
  writeFileSync(join(dir, "acme-widgets-old", "a.ts"), "old\n");
  const shims = join(work, "bin");
  mkdirSync(shims);
  writeFileSync(join(shims, "sleep"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(shims, "sleep"), 0o755);
  const body = serve === "good" ? goodArchive(work) : "not a gzip archive";
  let requests = 0;
  const server = Bun.serve({
    fetch: () => {
      requests += 1;
      return new Response(body);
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const command = (recipe ?? "")
    .replaceAll("https://api.github.com", `http://127.0.0.1:${server.port}`)
    .replaceAll("{owner}", "acme")
    .replaceAll("{repo}", "widgets")
    .replaceAll("{ref}", "main")
    .replaceAll("{dir}", dir);
  try {
    const child = Bun.spawn(["bash", "-c", command], {
      env: { ...process.env, PATH: `${shims}:${process.env.PATH ?? ""}` },
      stderr: "pipe",
      stdout: "pipe",
    });
    const code = await child.exited;
    return { code, dir, requests };
  } finally {
    server.stop(true);
  }
};

describe("the tarball recipe over a {dir} that already holds an older extract", () => {
  test("fails when every download fails, instead of passing on the stale tree", async () => {
    const run = await runInto("junk");
    expect(run.requests).toBe(3);
    expect(run.code).not.toBe(0);
  }, 60_000);

  test("still succeeds when this run extracts a fresh archive", async () => {
    const run = await runInto("good");
    expect(run.code).toBe(0);
    expect(readFileSync(join(run.dir, "acme-widgets-new", "a.ts"), "utf-8")).toBe(
      "new\n"
    );
  }, 60_000);
});
