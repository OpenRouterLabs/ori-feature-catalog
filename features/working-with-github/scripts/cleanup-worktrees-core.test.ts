import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { cleanupWorktrees } from "./cleanup-worktrees-core.ts";

interface FakeGitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** A fake `runGit` keyed on the subcommand (args[0] + args[1] for `worktree`),
 *  so a test scripts git's responses per call without a real repo. */
const fakeRunGit =
  (responses: Record<string, Partial<FakeGitResult>>) =>
  (args: readonly string[], _cwd: string): FakeGitResult => {
    const key = args.slice(0, 2).join(" ");
    const r = responses[key] ?? responses[args[0] ?? ""] ?? {};
    return {
      ok: r.ok ?? true,
      stderr: r.stderr ?? "",
      stdout: r.stdout ?? "",
    };
  };

const jsonFetch = (body: unknown, status = 200): Promise<Response> =>
  Promise.resolve(Response.json(body, { status }));

/** `readDir` fakes matching `withRealTmpDir`'s on-disk fixture (one "branch-a"
 *  subdir), or an empty root. */
const readDirWithBranchA = (): Promise<readonly string[]> =>
  Promise.resolve(["branch-a"]);
const readDirEmpty = (): Promise<readonly string[]> => Promise.resolve([]);

/** A throwaway root dir with one "branch-a" subdir, cleaned up after `run`
 *  resolves. `root` is real-pathed before handing it to `run`, so it matches
 *  what production code sees (`macOS` symlinks `/tmp` → `/private/tmp`, and the
 *  sweep canonicalizes every path it reports). */
const withRealTmpDir = async (
  run: (root: string) => Promise<void>
): Promise<void> => {
  const rawRoot = await mkdtemp(join(tmpdir(), "cleanup-worktrees-test-"));
  try {
    await mkdir(join(rawRoot, "branch-a"));
    await run(await realpath(rawRoot));
  } finally {
    await rm(rawRoot, {
      force: true,
      recursive: true,
    });
  }
};

describe("cleanupWorktrees", () => {
  test("removes a worktree whose PR is closed and tree is clean", () =>
    withRealTmpDir(async (root) => {
      const path = join(root, "branch-a");
      const runGit = fakeRunGit({
        "status --porcelain": { stdout: "" },
        "worktree list": {
          stdout: `worktree ${path}\nHEAD abc\nbranch refs/heads/branch-a\n\n`,
        },
        "worktree remove": { ok: true },
      });
      const fetchImpl = (): Promise<Response> =>
        jsonFetch([
          {
            number: 7,
            state: "closed",
          },
        ]);

      const summary = await Effect.runPromise(
        cleanupWorktrees(
          {
            fetchImpl,
            readDir: readDirWithBranchA,
            runGit,
            token: "tok",
          },
          {
            dryRun: false,
            repo: "owner/repo",
            repoDir: root,
            worktreesRoot: root,
          }
        )
      );

      expect(summary.outcomes).toEqual([
        {
          branch: "branch-a",
          decision: "removed",
          detail: "removed (PR #7 closed, tree clean)",
          path,
        },
      ]);
    }));

  test("tolerates the extra fields a real PR body carries", () =>
    withRealTmpDir(async (root) => {
      const path = join(root, "branch-a");
      const runGit = fakeRunGit({
        "worktree list": {
          stdout: `worktree ${path}\nHEAD abc\nbranch refs/heads/branch-a\n\n`,
        },
      });
      const fetchImpl = (): Promise<Response> =>
        jsonFetch([
          {
            draft: false,
            merged_at: "2026-01-01T00:00:00Z",
            number: 3,
            some_field_added_next_year: true,
            state: "open",
            title: "a pull request",
          },
        ]);

      const summary = await Effect.runPromise(
        cleanupWorktrees(
          {
            fetchImpl,
            readDir: readDirWithBranchA,
            runGit,
            token: "tok",
          },
          {
            dryRun: false,
            repo: "owner/repo",
            repoDir: root,
            worktreesRoot: root,
          }
        )
      );

      expect(summary.outcomes).toEqual([
        {
          branch: "branch-a",
          decision: "skipped-open-pr",
          detail: "PR #3 is still open",
          path,
        },
      ]);
    }));

  test("a PR entry with a malformed state never removes the worktree", () =>
    withRealTmpDir(async (root) => {
      const path = join(root, "branch-a");
      let removed = false;
      const runGit = fakeRunGit({
        "status --porcelain": { stdout: "" },
        "worktree list": {
          stdout: `worktree ${path}\nHEAD abc\nbranch refs/heads/branch-a\n\n`,
        },
      });
      const fetchImpl = (): Promise<Response> =>
        jsonFetch([
          {
            number: 7,
            state: "merged",
          },
        ]);

      const summary = await Effect.runPromise(
        cleanupWorktrees(
          {
            fetchImpl,
            readDir: readDirWithBranchA,
            runGit: (args, cwd) => {
              if (args[0] === "worktree" && args[1] === "remove") {
                removed = true;
              }
              return runGit(args, cwd);
            },
            token: "tok",
          },
          {
            dryRun: false,
            repo: "owner/repo",
            repoDir: root,
            worktreesRoot: root,
          }
        )
      );

      // "merged" is not a state this code has ever reasoned about, so the sweep
      // falls back to "no PR found" — the branch that keeps the worktree.
      expect(summary.outcomes).toEqual([
        {
          branch: "branch-a",
          decision: "skipped-no-pr",
          detail: "no PR found for this branch",
          path,
        },
      ]);
      expect(removed).toBe(false);
    }));

  test("skips a worktree with an open PR", () =>
    withRealTmpDir(async (root) => {
      const path = join(root, "branch-a");
      const runGit = fakeRunGit({
        "worktree list": {
          stdout: `worktree ${path}\nHEAD abc\nbranch refs/heads/branch-a\n\n`,
        },
      });
      const fetchImpl = (): Promise<Response> =>
        jsonFetch([
          {
            number: 3,
            state: "open",
          },
        ]);

      const summary = await Effect.runPromise(
        cleanupWorktrees(
          {
            fetchImpl,
            readDir: readDirWithBranchA,
            runGit,
            token: "tok",
          },
          {
            dryRun: false,
            repo: "owner/repo",
            repoDir: root,
            worktreesRoot: root,
          }
        )
      );

      expect(summary.outcomes).toEqual([
        {
          branch: "branch-a",
          decision: "skipped-open-pr",
          detail: "PR #3 is still open",
          path,
        },
      ]);
    }));

  test("skips a worktree with no matching PR", () =>
    withRealTmpDir(async (root) => {
      const path = join(root, "branch-a");
      const runGit = fakeRunGit({
        "worktree list": {
          stdout: `worktree ${path}\nHEAD abc\nbranch refs/heads/branch-a\n\n`,
        },
      });
      const fetchImpl = (): Promise<Response> => jsonFetch([]);

      const summary = await Effect.runPromise(
        cleanupWorktrees(
          {
            fetchImpl,
            readDir: readDirWithBranchA,
            runGit,
            token: "tok",
          },
          {
            dryRun: false,
            repo: "owner/repo",
            repoDir: root,
            worktreesRoot: root,
          }
        )
      );

      expect(summary.outcomes).toEqual([
        {
          branch: "branch-a",
          decision: "skipped-no-pr",
          detail: "no PR found for this branch",
          path,
        },
      ]);
    }));

  test("skips a worktree whose PR is closed but has uncommitted changes", () =>
    withRealTmpDir(async (root) => {
      const path = join(root, "branch-a");
      const runGit = fakeRunGit({
        "status --porcelain": { stdout: " M dirty-file.ts\n" },
        "worktree list": {
          stdout: `worktree ${path}\nHEAD abc\nbranch refs/heads/branch-a\n\n`,
        },
      });
      const fetchImpl = (): Promise<Response> =>
        jsonFetch([
          {
            number: 9,
            state: "closed",
          },
        ]);

      const summary = await Effect.runPromise(
        cleanupWorktrees(
          {
            fetchImpl,
            readDir: readDirWithBranchA,
            runGit,
            token: "tok",
          },
          {
            dryRun: false,
            repo: "owner/repo",
            repoDir: root,
            worktreesRoot: root,
          }
        )
      );

      expect(summary.outcomes).toEqual([
        {
          branch: "branch-a",
          decision: "skipped-dirty",
          detail: "PR #9 is closed, but the worktree has uncommitted changes",
          path,
        },
      ]);
    }));

  test("dry-run reports the removal decision without calling `git worktree remove`", () =>
    withRealTmpDir(async (root) => {
      const path = join(root, "branch-a");
      let removeCalled = false;
      const runGit = fakeRunGit({
        "status --porcelain": { stdout: "" },
        "worktree list": {
          stdout: `worktree ${path}\nHEAD abc\nbranch refs/heads/branch-a\n\n`,
        },
      });
      const trackingRunGit = (
        args: readonly string[],
        cwd: string
      ): FakeGitResult => {
        if (args[0] === "worktree" && args[1] === "remove") {
          removeCalled = true;
        }
        return runGit(args, cwd);
      };
      const fetchImpl = (): Promise<Response> =>
        jsonFetch([
          {
            number: 7,
            state: "closed",
          },
        ]);

      const summary = await Effect.runPromise(
        cleanupWorktrees(
          {
            fetchImpl,
            readDir: readDirWithBranchA,
            runGit: trackingRunGit,
            token: "tok",
          },
          {
            dryRun: true,
            repo: "owner/repo",
            repoDir: root,
            worktreesRoot: root,
          }
        )
      );

      expect(removeCalled).toBe(false);
      expect(summary.outcomes).toEqual([
        {
          branch: "branch-a",
          decision: "removed",
          detail: "dry-run — would remove (PR #7 closed, tree clean)",
          path,
        },
      ]);
    }));

  test("reports an on-disk directory `git worktree list` doesn't know about as a stray, never removing it", () =>
    withRealTmpDir(async (root) => {
      const runGit = fakeRunGit({ "worktree list": { stdout: "" } });
      const fetchImpl = (): Promise<Response> => jsonFetch([]);

      const summary = await Effect.runPromise(
        cleanupWorktrees(
          {
            fetchImpl,
            readDir: readDirWithBranchA,
            runGit,
            token: "tok",
          },
          {
            dryRun: false,
            repo: "owner/repo",
            repoDir: root,
            worktreesRoot: root,
          }
        )
      );

      expect(summary.outcomes).toEqual([
        {
          branch: "",
          decision: "skipped-stray",
          detail:
            "on disk but unknown to `git worktree list` — run `git worktree prune` or inspect manually",
          path: join(root, "branch-a"),
        },
      ]);
    }));

  test("always calls `git worktree prune` once per sweep", () =>
    withRealTmpDir(async (root) => {
      let pruneCalls = 0;
      const runGit = fakeRunGit({ "worktree list": { stdout: "" } });
      const trackingRunGit = (
        args: readonly string[],
        cwd: string
      ): FakeGitResult => {
        if (args[0] === "worktree" && args[1] === "prune") {
          pruneCalls += 1;
        }
        return runGit(args, cwd);
      };
      await Effect.runPromise(
        cleanupWorktrees(
          {
            fetchImpl: (): Promise<Response> => jsonFetch([]),
            readDir: readDirEmpty,
            runGit: trackingRunGit,
            token: "tok",
          },
          {
            dryRun: false,
            repo: "owner/repo",
            repoDir: root,
            worktreesRoot: root,
          }
        )
      );
      expect(pruneCalls).toBe(1);
    }));

  test("never touches a tracked worktree path that git reports outside the worktrees root (e.g. the repo checkout itself)", () =>
    withRealTmpDir(async (root) => {
      const outside = "/tmp/definitely-not-under-root";
      let removeCalled = false;
      const runGit = fakeRunGit({
        "worktree list": {
          stdout: `worktree ${outside}\nHEAD abc\nbranch refs/heads/main\n\n`,
        },
      });
      const trackingRunGit = (
        args: readonly string[],
        cwd: string
      ): FakeGitResult => {
        if (args[0] === "worktree" && args[1] === "remove") {
          removeCalled = true;
        }
        return runGit(args, cwd);
      };

      const summary = await Effect.runPromise(
        cleanupWorktrees(
          {
            fetchImpl: (): Promise<Response> =>
              jsonFetch([
                {
                  number: 1,
                  state: "closed",
                },
              ]),
            readDir: readDirEmpty,
            runGit: trackingRunGit,
            token: "tok",
          },
          {
            dryRun: false,
            repo: "owner/repo",
            repoDir: root,
            worktreesRoot: root,
          }
        )
      );

      expect(removeCalled).toBe(false);
      // Out of scope, not an error — it never even appears in the outcomes.
      expect(summary.outcomes).toEqual([]);
    }));
});
