import { expect, test } from "bun:test";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { saveMemory } from "../memory-tools/index.ts";
import { git, withTempDir } from "../test-support/index.ts";

import { INTERN_ROOT_ENV, resolveInternRoot } from "./index.ts";

const NOW = new Date("2026-10-13T14:02:00.000Z");

test("a save from a session worktree under .sessions lands in the intern root", async () => {
  await withTempDir(async (root) => {
    git(root, "init", "--quiet");
    git(root, "commit", "--quiet", "--allow-empty", "-m", "init");
    await mkdir(path.join(root, ".sessions"));
    const session = path.join(root, ".sessions", "x");
    git(root, "worktree", "add", "--quiet", "-b", "session-x", session);

    await saveMemory(
      { hint: session, env: {}, now: NOW },
      { text: "Saved from a worktree." }
    );

    expect(await readdir(path.join(root, "memory", "log"))).toEqual([
      "2026-10.md",
    ]);
    expect(await readdir(session)).not.toContain("memory");
  });
});

test("the exported intern root wins, and a plain directory resolves to itself", async () => {
  await withTempDir(async (directory) => {
    expect(
      await resolveInternRoot({
        hint: directory,
        env: { [INTERN_ROOT_ENV]: " /srv/intern " },
      })
    ).toBe("/srv/intern");
    expect(
      await resolveInternRoot({
        hint: directory,
        env: { [INTERN_ROOT_ENV]: "  " },
      })
    ).toBe(directory);
  });
});

test("a save from a linked worktree with a separate git dir stays in the session, not the metadata dir", async () => {
  await withTempDir(async (base) => {
    const gits = path.join(base, "srv", "git");
    const main = path.join(base, "srv", "intern");
    await mkdir(gits, { recursive: true });
    git(base, "init", "--quiet", "--initial-branch=master", "--bare", path.join(gits, "seed.git"));
    git(base, "init", "--quiet", "--initial-branch=master", path.join(base, "wk"));
    git(path.join(base, "wk"), "commit", "--quiet", "--allow-empty", "-m", "init");
    git(path.join(base, "wk"), "push", "--quiet", path.join(gits, "seed.git"), "master");
    const clone = Bun.spawnSync(
      [
        "git",
        "clone",
        "--quiet",
        "--separate-git-dir",
        path.join(gits, "intern.git"),
        path.join(gits, "seed.git"),
        main,
      ],
      { cwd: base, stdout: "pipe", stderr: "pipe" }
    );
    if (clone.exitCode !== 0) {
      throw new Error(clone.stderr.toString());
    }
    const session = path.join(base, "sess");
    git(main, "worktree", "add", "--quiet", "--detach", session);

    expect(await resolveInternRoot({ hint: session, env: {} })).toBe(session);
    expect(await resolveInternRoot({ hint: main, env: {} })).toBe(main);
  });
});
