import { afterEach, describe, expect, test } from "bun:test";

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { cleanupWorktrees } from "./cleanup-worktrees-core.ts";

// A branch name comes free again once its worktree and local branch are gone
// (the sweep's own `git branch -D`, step 7 of the change flow), and the next
// task may reuse it: `fix-typo` again. GitHub still lists the OLD closed PR
// for `head=owner:fix-typo`, and the new worktree is clean right after `git
// worktree add` and after every commit-via-api run. Pre-fix that old PR
// decided for the new worktree: the sweep removed it mid-task and deleted its
// branch, reporting "removed (PR #42 closed, tree clean)" for work PR #42
// never carried. The PR's head sha now has to be the worktree's HEAD.

const GIT_ENV = {
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_AUTHOR_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
};

const git = (args: readonly string[], cwd: string): string => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
};

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

/** A checkout and one worktree on `fix-typo` under the sweep's slug layout. */
const fixture = () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "wwg-reused-branch-")));
  scratch.push(work);
  const checkout = join(work, "checkout");
  const root = join(work, "worktrees");
  const wt = join(root, "acme-widgets", "fix-typo");
  git(["init", "-q", "-b", "main", checkout], work);
  git(["commit", "-q", "--allow-empty", "-m", "init"], checkout);
  const base = git(["rev-parse", "HEAD"], checkout);
  git(["worktree", "add", "-q", wt, "-b", "fix-typo", "main"], checkout);
  return { base, checkout, root, wt };
};

const sweep = (input: {
  readonly checkout: string;
  readonly root: string;
  readonly headSha: string;
}) =>
  Effect.runPromise(
    cleanupWorktrees(
      {
        fetchImpl: () =>
          Promise.resolve(
            Response.json([
              { head: { sha: input.headSha }, number: 42, state: "closed" },
            ])
          ),
        token: "tok",
      },
      {
        dryRun: false,
        repo: "acme/widgets",
        repoDir: input.checkout,
        repoSlug: "acme-widgets",
        worktreesRoot: input.root,
      }
    )
  );

describe("a closed PR only retires the worktree whose HEAD it carried", () => {
  test("a reused branch name with new work keeps its worktree and branch", async () => {
    const { checkout, root, wt } = fixture();
    const oldHead = "1111111111111111111111111111111111111111";
    const summary = await sweep({ checkout, headSha: oldHead, root });
    const outcome = summary.outcomes.find((entry) => entry.path === wt);
    expect(outcome?.decision).toBe("skipped-no-pr");
    expect(outcome?.detail).toContain("PR #42 is closed");
    expect(outcome?.detail).toContain("earlier head");
    expect(git(["branch", "--list", "fix-typo"], checkout)).toContain(
      "fix-typo"
    );
    expect(git(["worktree", "list", "--porcelain"], checkout)).toContain(wt);
  });

  test("the worktree the closed PR carried is still removed", async () => {
    const { base, checkout, root, wt } = fixture();
    const summary = await sweep({ checkout, headSha: base, root });
    const outcome = summary.outcomes.find((entry) => entry.path === wt);
    expect(outcome?.decision).toBe("removed");
    expect(outcome?.detail).toBe("removed (PR #42 closed, tree clean)");
    expect(git(["branch", "--list", "fix-typo"], checkout)).toBe("");
  });
});
