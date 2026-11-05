import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { STRAY_CLONE_DETAIL, cleanupWorktrees } from "./cleanup-worktrees-core.ts";

/**
 * Regression: the open-pr skill clones a PR's code to
 * `/tmp/worktrees/<slug>/<branch>`, inside this sweep's scope. That clone is
 * its own repository (a `.git` directory), never a worktree of the checkout,
 * so every sweep reported it as `skipped-stray` with "run `git worktree
 * prune`", a remedy that never clears it: a leftover clone came back on every
 * daily fire with advice that could not work. A stray that is a standalone
 * clone now says what it is and how to remove it; any other stray keeps the
 * prune advice.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

const noFetch = (): Promise<Response> => Promise.reject(new Error("no PR lookup expected"));

describe("a standalone clone under the slug dir is named as one", () => {
  test("the open-pr clone gets the clone remedy, a plain stray dir keeps the prune advice", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wwg-stray-clone-")));
    try {
      const checkout = join(root, "checkout");
      mkdirSync(checkout);
      git(checkout, "init", "-q", "-b", "main");
      writeFileSync(join(checkout, "a.txt"), "one\n");
      git(checkout, "add", ".");
      git(checkout, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
      const clone = join(root, "worktrees", "owner-repo", "fix-typo");
      git(root, "clone", "-q", checkout, clone);
      const stray = join(root, "worktrees", "owner-repo", "leftover");
      mkdirSync(stray);
      writeFileSync(join(stray, ".git"), "gitdir: /nowhere/.git/worktrees/leftover\n");
      const summary = await Effect.runPromise(
        cleanupWorktrees(
          { fetchImpl: noFetch, token: "t" },
          {
            dryRun: true,
            repo: "owner/repo",
            repoDir: checkout,
            repoSlug: "owner-repo",
            worktreesRoot: join(root, "worktrees"),
          }
        )
      );
      const byPath = new Map(summary.outcomes.map((o) => [o.path, o]));
      expect(byPath.get(clone)?.decision).toBe("skipped-stray");
      expect(byPath.get(clone)?.detail).toBe(STRAY_CLONE_DETAIL);
      expect(byPath.get(clone)?.detail).not.toContain("run `git worktree prune`");
      expect(byPath.get(stray)?.decision).toBe("skipped-stray");
      expect(byPath.get(stray)?.detail).toContain("run `git worktree prune`");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
