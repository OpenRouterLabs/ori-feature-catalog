import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { STRAY_CLONE_DETAIL, cleanupWorktrees } from "./cleanup-worktrees-core.ts";

/**
 * Regression: a branch namespace (`fix/`) that holds a tracked worktree
 * (`fix/a`) was dropped from the stray scan whole, as the ancestor of a
 * tracked path. Any stray beside that worktree (an open-pr clone at `fix/b`,
 * a leftover `fix/c` directory) was never reported, though the same stray
 * under a namespace holding no tracked worktree was. The container is now
 * descended and each child judged on its own; the tracked worktree and the
 * container stay unreported.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

const noPr = (): Promise<Response> => Promise.resolve(new Response("[]", { status: 200 }));

describe("a stray beside a tracked worktree in the same branch namespace", () => {
  test("is reported at its own path, the tracked worktree and the container are not", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wwg-stray-beside-")));
    try {
      const checkout = join(root, "checkout");
      mkdirSync(checkout);
      git(checkout, "init", "-q", "-b", "main");
      writeFileSync(join(checkout, "a.txt"), "one\n");
      git(checkout, "add", ".");
      git(checkout, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
      const slugDir = join(root, "worktrees", "owner-repo");
      const tracked = join(slugDir, "fix", "a");
      const deepTracked = join(slugDir, "feat", "x", "y");
      git(checkout, "worktree", "add", "-q", "-b", "fix/a", tracked);
      git(checkout, "worktree", "add", "-q", "-b", "feat/x/y", deepTracked);
      const clone = join(slugDir, "fix", "b");
      git(root, "clone", "-q", checkout, clone);
      const leftover = join(slugDir, "fix", "c");
      mkdirSync(leftover);
      writeFileSync(join(leftover, "notes.txt"), "x\n");
      const deepClone = join(slugDir, "feat", "x", "z");
      git(root, "clone", "-q", checkout, deepClone);
      mkdirSync(join(slugDir, "fix", "empty"));
      const summary = await Effect.runPromise(
        cleanupWorktrees(
          { fetchImpl: noPr, token: "t" },
          {
            dryRun: true,
            repo: "owner/repo",
            repoDir: checkout,
            repoSlug: "owner-repo",
            worktreesRoot: join(root, "worktrees"),
          }
        )
      );
      const strays = new Map(
        summary.outcomes.filter((o) => o.decision === "skipped-stray").map((o) => [o.path, o.detail])
      );
      expect(strays.get(clone)).toBe(STRAY_CLONE_DETAIL);
      expect(strays.get(deepClone)).toBe(STRAY_CLONE_DETAIL);
      expect(strays.get(leftover)).toContain("run `git worktree prune`");
      expect([...strays.keys()].sort()).toEqual([clone, leftover, deepClone].sort());
      expect(summary.outcomes.find((o) => o.path === tracked)?.decision).toBe("skipped-no-pr");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
