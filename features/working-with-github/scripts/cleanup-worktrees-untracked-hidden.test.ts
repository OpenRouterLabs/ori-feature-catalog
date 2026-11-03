import { afterEach, describe, expect, test } from "bun:test";

import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { cleanupWorktrees } from "./cleanup-worktrees-core.ts";

// The sweep's clean check read a bare `git status --porcelain`, which obeys
// the repo's `status.showUntrackedFiles`. With it set to `no` (the setting
// git's own docs suggest for large repos), a new file never committed reads
// as a clean tree, and `git worktree remove`, which honors the same setting,
// deleted it along with the worktree: the sweep destroyed uncommitted work
// its safety model says it never touches. The check now asks for untracked
// files explicitly.

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

const sweepClosedPr = (checkout: string, root: string, headSha: string) =>
  Effect.runPromise(
    cleanupWorktrees(
      {
        fetchImpl: () =>
          Promise.resolve(
            Response.json([{ head: { sha: headSha }, number: 42, state: "closed" }])
          ),
        token: "tok",
      },
      {
        dryRun: false,
        repo: "acme/widgets",
        repoDir: checkout,
        repoSlug: "acme-widgets",
        worktreesRoot: root,
      }
    )
  );

describe("the sweep never deletes untracked work the repo config hides", () => {
  test("status.showUntrackedFiles=no still keeps a worktree holding a new file", async () => {
    const work = realpathSync(mkdtempSync(join(tmpdir(), "wwg-untracked-hidden-")));
    scratch.push(work);
    const checkout = join(work, "checkout");
    const root = join(work, "worktrees");
    const wt = join(root, "acme-widgets", "fix-typo");
    git(["init", "-q", "-b", "main", checkout], work);
    git(["commit", "-q", "--allow-empty", "-m", "init"], checkout);
    git(["worktree", "add", "-q", wt, "-b", "fix-typo", "main"], checkout);
    git(["config", "status.showUntrackedFiles", "no"], checkout);
    writeFileSync(join(wt, "notes.md"), "uncommitted work\n");
    expect(git(["status", "--porcelain"], wt)).toBe("");

    const summary = await sweepClosedPr(checkout, root, git(["rev-parse", "HEAD"], wt));
    const outcome = summary.outcomes.find((entry) => entry.path === wt);
    expect(outcome?.decision).toBe("skipped-dirty");
    expect(existsSync(join(wt, "notes.md"))).toBe(true);
  });
});
