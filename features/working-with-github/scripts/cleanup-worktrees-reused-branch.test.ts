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
//
// The PR can also have moved PAST the worktree's HEAD before it merged:
// GitHub's "Update branch" button, a bot's merge commit, or a review fix
// pushed from another checkout. The worktree's HEAD is then one of the PR's
// own commits, and the PR did carry its work. Pre-fix that read as "an
// earlier head" too, so the worktree was reported skipped-no-pr on every
// sweep and never reclaimed. The sweep now reads the PR's commit list when
// the heads differ.

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
  /** The PR's own commit list; omitted → the PR carried only its head. */
  readonly prCommits?: readonly string[] | "fails";
  readonly urls?: string[];
}) =>
  Effect.runPromise(
    cleanupWorktrees(
      {
        fetchImpl: (url) => {
          input.urls?.push(url);
          if (url.includes("/pulls/42/commits")) {
            return Promise.resolve(
              input.prCommits === "fails"
                ? Response.json({ message: "Server Error" }, { status: 502 })
                : Response.json(
                    (input.prCommits ?? [input.headSha]).map((sha) => ({ sha }))
                  )
            );
          }
          return Promise.resolve(
            Response.json([
              { head: { sha: input.headSha }, number: 42, state: "closed" },
            ])
          );
        },
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
    const urls: string[] = [];
    const summary = await sweep({ checkout, headSha: oldHead, root, urls });
    const outcome = summary.outcomes.find((entry) => entry.path === wt);
    expect(outcome?.decision).toBe("skipped-no-pr");
    expect(outcome?.detail).toContain("PR #42 is closed");
    expect(outcome?.detail).toContain("earlier head");
    expect(git(["branch", "--list", "fix-typo"], checkout)).toContain(
      "fix-typo"
    );
    expect(git(["worktree", "list", "--porcelain"], checkout)).toContain(wt);
    expect(urls.some((url) => url.includes("/pulls/42/commits"))).toBe(true);
  });

  test("a PR merged after its branch moved past the worktree's HEAD still retires the worktree", async () => {
    const { checkout, root, wt } = fixture();
    git(["commit", "-q", "--allow-empty", "-m", "the fix"], wt);
    const worktreeHead = git(["rev-parse", "HEAD"], wt);
    const updatedHead = "2222222222222222222222222222222222222222";
    const summary = await sweep({
      checkout,
      headSha: updatedHead,
      prCommits: [worktreeHead, updatedHead],
      root,
    });
    const outcome = summary.outcomes.find((entry) => entry.path === wt);
    expect(outcome?.decision).toBe("removed");
    expect(outcome?.detail).toBe("removed (PR #42 closed, tree clean)");
    expect(git(["branch", "--list", "fix-typo"], checkout)).toBe("");
  });

  test("a reused branch cut from the base an unmerged PR started on keeps its worktree", async () => {
    const { base, checkout, root, wt } = fixture();
    const oldHead = "1111111111111111111111111111111111111111";
    const summary = await sweep({
      checkout,
      headSha: oldHead,
      prCommits: [oldHead],
      root,
    });
    const outcome = summary.outcomes.find((entry) => entry.path === wt);
    expect(git(["rev-parse", "HEAD"], wt)).toBe(base);
    expect(outcome?.decision).toBe("skipped-no-pr");
    expect(git(["worktree", "list", "--porcelain"], checkout)).toContain(wt);
  });

  test("a commit lookup that fails is an error and keeps the worktree", async () => {
    const { checkout, root, wt } = fixture();
    const summary = await sweep({
      checkout,
      headSha: "3333333333333333333333333333333333333333",
      prCommits: "fails",
      root,
    });
    const outcome = summary.outcomes.find((entry) => entry.path === wt);
    expect(outcome?.decision).toBe("error");
    expect(outcome?.detail).toContain("PR #42 commit lookup failed");
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
