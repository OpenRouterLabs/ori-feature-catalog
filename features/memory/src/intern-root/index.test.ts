import { expect, test } from "bun:test";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { saveMemory } from "#src/memory-tools/index.ts";
import { git, withTempDir } from "#src/test-support/index.ts";

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
