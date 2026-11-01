import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { cleanupWorktrees } from "./cleanup-worktrees-core.ts";

/**
 * Regression (the emptied-namespace false-stray class): a slash-bearing
 * branch (`fix/topic`, `wwg/rotated-token` — the common GitHub convention)
 * puts its worktree at `<root>/<slug>/fix/topic`. `git worktree remove` —
 * the prompt's step 7 and the sweep's own removal alike — deletes only the
 * worktree directory and leaves the emptied `fix/` behind. Pre-fix every
 * later sweep reported that container as `skipped-stray` ("unknown to `git
 * worktree list` — run `git worktree prune`"), forever: prune cannot clear a
 * directory git never tracked, so the advice was a no-op and the line came
 * back on every daily fire. A worktree checkout is never empty (it always
 * holds its `.git` link), so an empty directory is not a stray worktree.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

const closedPr = (): Promise<Response> =>
  Promise.resolve(Response.json([{ number: 7, state: "closed" }]));

const withCheckout = async (
  run: (root: string, checkout: string, worktree: string) => Promise<void>
): Promise<void> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wwg-slash-branch-")));
  try {
    const checkout = join(root, "checkout");
    mkdirSync(checkout);
    git(checkout, "init", "-q", "-b", "main");
    writeFileSync(join(checkout, "a.txt"), "one\n");
    git(checkout, "add", ".");
    git(checkout, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
    const worktree = join(root, "worktrees", "owner-repo", "fix", "topic");
    git(checkout, "worktree", "add", "-q", worktree, "-b", "fix/topic");
    await run(root, checkout, worktree);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

const sweep = (root: string, checkout: string) =>
  Effect.runPromise(
    cleanupWorktrees(
      { fetchImpl: closedPr, token: "t" },
      {
        dryRun: false,
        repo: "owner/repo",
        repoDir: checkout,
        repoSlug: "owner-repo",
        worktreesRoot: join(root, "worktrees"),
      }
    )
  );

describe("a removed slash-branch worktree leaves no false stray behind", () => {
  test("the sweep's own removal is followed by a quiet sweep", () =>
    withCheckout(async (root, checkout, worktree) => {
      const first = await sweep(root, checkout);
      expect(first.outcomes.map((o) => [o.decision, o.path])).toEqual([
        ["removed", worktree],
      ]);
      const second = await sweep(root, checkout);
      expect(second.outcomes).toEqual([]);
    }));

  test("the prompt's own `git worktree remove \"$WT\"` is followed by a quiet sweep", () =>
    withCheckout(async (root, checkout, worktree) => {
      git(checkout, "worktree", "remove", worktree);
      const summary = await sweep(root, checkout);
      expect(summary.outcomes).toEqual([]);
    }));

  test("a real stray checkout under the namespace dir is still reported", () =>
    withCheckout(async (root, checkout, worktree) => {
      git(checkout, "worktree", "remove", worktree);
      const leftover = join(root, "worktrees", "owner-repo", "fix", "other");
      mkdirSync(leftover, { recursive: true });
      writeFileSync(join(leftover, ".git"), "gitdir: /gone\n");
      const summary = await sweep(root, checkout);
      expect(summary.outcomes.map((o) => [o.decision, o.path])).toEqual([
        ["skipped-stray", join(root, "worktrees", "owner-repo", "fix")],
      ]);
    }));
});
