// network-timeout.test.ts for branch A (sweep only) — the ambient-probe cases
// move to branch B's file to keep one concern per PR.
import { describe, expect, test } from "bun:test";
// A sweep that can wait forever can never report. Pre-fix `findPrForBranch`
// wrapped its page fetch in `Effect.tryPromise` and nothing else: a hung
// connection to api.github.com (a dropped route, a wedged proxy) left the
// whole sweep pending forever — `evaluateWorktree`'s `{ concurrency: 1 }`
// queue stalled behind it, every later daily fire was skipped as
// still-running, and the worktrees the schedule exists to reclaim simply
// accumulated.
//
// The lookup now bounds the wait and surfaces the same `error`-outcome
// per-worktree channel a 403 rate limit already uses. The deadline test
// waits out a real 15s timeout against a fetch that never settles (the
// honest wedge shape), so it carries a 25s per-test timeout.
import { Effect } from "effect";

import { cleanupWorktrees } from "./cleanup-worktrees-core.ts";

/** A fetch seam whose promise NEVER settles — the hung-connection shape. */
const neverFetch = (): Promise<Response> => new Promise<Response>(() => {});

const fakeRunGit = (args: readonly string[]) => {
  const key = args.slice(0, 2).join(" ");
  if (key === "worktree list") {
    return {
      ok: true,
      stdout:
        "worktree /tmp/worktrees/owner-repo/branch-a\nHEAD abc\nbranch refs/heads/branch-a\n\n",
      stderr: "",
    };
  }
  return { ok: true, stdout: "", stderr: "" };
};

describe("a PR lookup that never settles fails the sweep, never wedges it", () => {
  test(
    "the sweep reports a per-worktree error outcome instead of hanging",
    async () => {
      const summary = await Effect.runPromise(
        cleanupWorktrees(
          {
            fetchImpl: neverFetch,
            readDir: async () => [],
            runGit: fakeRunGit,
          },
          {
            dryRun: true,
            repo: "owner/repo",
            repoDir: "/repo",
            worktreesRoot: "/tmp/worktrees",
          }
        )
      );
      expect(summary.outcomes).toHaveLength(1);
      expect(summary.outcomes[0]?.decision).toBe("error");
      expect(summary.outcomes[0]?.detail).toContain("PR lookup failed");
      expect(summary.outcomes[0]?.detail).toContain("did not answer within");
    },
    25_000
  );

  test("the sweep's happy path is unchanged: a closed PR still removes the worktree", async () => {
    const summary = await Effect.runPromise(
      cleanupWorktrees(
        {
          fetchImpl: () =>
            Promise.resolve(
              Response.json([{ number: 7, state: "closed" }])
            ) as Promise<Response>,
          readDir: async () => [],
          runGit: fakeRunGit,
        },
        {
          dryRun: false,
          repo: "owner/repo",
          repoDir: "/repo",
          worktreesRoot: "/tmp/worktrees",
        }
      )
    );
    expect(summary.outcomes).toEqual([
      {
        branch: "branch-a",
        decision: "removed",
        detail: "removed (PR #7 closed, tree clean)",
        path: "/tmp/worktrees/owner-repo/branch-a",
      },
    ]);
  });
});
