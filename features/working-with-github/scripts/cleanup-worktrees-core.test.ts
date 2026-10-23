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

/** A real temp root laid out the way the feature's own docs specify:
 *  `<worktrees-root>/<repo-slug>/<branch>` (see the "Modifying your own code"
 *  flow in prompt.md and cleanup-worktrees.ts's own docstring). */
const withRealSlugDir = async (
  run: (root: string, slug: string) => Promise<void>
): Promise<void> => {
  const rawRoot = await mkdtemp(join(tmpdir(), "cleanup-worktrees-slug-"));
  const slug = "acme-corp-helper-bot";
  try {
    await mkdir(join(rawRoot, slug, "branch-a"), {
      recursive: true,
    });
    await run(await realpath(rawRoot), slug);
  } finally {
    await rm(rawRoot, {
      force: true,
      recursive: true,
    });
  }
};

/** A real temp root with one "branch-a" subdir, cleaned up after `run`
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
  test("a failed `git worktree list` is an error outcome, never a silent empty sweep", async () => {
    // repoDir is NOT a git repository: `git worktree list` exits non-zero.
    // Pre-fix: the failure read as "no worktrees" — the sweep reported
    // nothing and the CLI exited 0 ("nothing under the worktrees root") as
    // if the tree were empty.
    const rawRoot = await mkdtemp(join(tmpdir(), "not-a-repo-root-"));
    try {
      const root = await realpath(rawRoot);
      const summary = await Effect.runPromise(
        cleanupWorktrees(
          { readDir: readDirEmpty, token: "tok" },
          {
            dryRun: true,
            repo: "owner/repo",
            repoDir: root,
            worktreesRoot: root,
          }
        )
      );
      expect(summary.gitListFailed).toBe(true);
      expect(summary.outcomes).toHaveLength(1);
      expect(summary.outcomes[0]?.decision).toBe("error");
      expect(summary.outcomes[0]?.detail).toContain(
        "git worktree list failed"
      );
    } finally {
      await rm(rawRoot, { force: true, recursive: true });
    }
  });

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

  test("in the documented `<root>/<slug>/<branch>` layout, the slug dir is not a stray", () =>
    withRealSlugDir(async (root, slug) => {
      const path = join(root, slug, "branch-a");
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
            // The on-disk view of `<root>` is just the slug directory; the
            // sweep must descend one level to see the per-branch worktrees.
            readDir: (dir: string): Promise<readonly string[]> =>
              dir === root
                ? Promise.resolve([slug])
                : dir === join(root, slug)
                  ? Promise.resolve(["branch-a"])
                  : Promise.resolve([]),
            runGit,
            token: "tok",
          },
          {
            dryRun: false,
            repo: "acme-corp/helper-bot",
            repoDir: root,
            worktreesRoot: root,
          }
        )
      );

      // Exactly one outcome: the open-PR skip for the tracked worktree. The slug
      // directory is a container, not a stray.
      expect(summary.outcomes).toEqual([
        {
          branch: "branch-a",
          decision: "skipped-open-pr",
          detail: "PR #3 is still open",
          path,
        },
      ]);
    }));

  test("the repo checkout itself is never a removal candidate, even when it sits under the worktrees root", () =>
    withRealTmpDir(async (root) => {
      // A layout where the repo checkout lives INSIDE the worktrees root
      // (e.g. `--worktrees-root` pointed one level wide, or a checkout created
      // under /tmp/worktrees/). `git worktree list --porcelain` tracks the
      // checkout as a normal `branch refs/heads/main` entry, so the
      // containment filter alone admits it; with its PR merged/closed and its
      // tree clean the sweep then ran `git worktree remove` on the live
      // checkout. Pre-fix outcome: a spurious `error` ("is a main working
      // tree") — or a deleted checkout, had git not refused.
      const checkout = join(root, "checkout");
      await mkdir(checkout);
      const wt = join(root, "branch-a");
      const runGit = fakeRunGit({
        "status --porcelain": { stdout: "" },
        "worktree list": {
          stdout:
            `worktree ${checkout}\nHEAD abc\nbranch refs/heads/main\n\n` +
            `worktree ${wt}\nHEAD abc\nbranch refs/heads/branch-a\n\n`,
        },
        "worktree remove": { ok: true },
      });
      const removeTargets: string[] = [];
      const fetchImpl = (): Promise<Response> =>
        jsonFetch([{ number: 7, state: "closed" }]);

      const summary = await Effect.runPromise(
        cleanupWorktrees(
          {
            fetchImpl,
            readDir: readDirWithBranchA,
            runGit: (args, cwd) => {
              if (args[0] === "worktree" && args[1] === "remove") {
                removeTargets.push(args[2] ?? "");
              }
              return runGit(args, cwd);
            },
            token: "tok",
          },
          {
            dryRun: false,
            repo: "owner/repo",
            repoDir: checkout,
            worktreesRoot: root,
          }
        )
      );

      // The checkout is out of scope entirely — not an error, not a skip
      // report, not present at all, exactly as the module doc promises. The
      // sibling worktree is still swept normally.
      expect(summary.outcomes).toEqual([
        {
          branch: "branch-a",
          decision: "removed",
          detail: "removed (PR #7 closed, tree clean)",
          path: wt,
        },
      ]);
      expect(removeTargets).toEqual([wt]);
    }));

  test("a stray slug directory with no tracked worktree under it is still reported", () =>
    withRealSlugDir(async (root, slug) => {
      const runGit = fakeRunGit({ "worktree list": { stdout: "" } });

      const summary = await Effect.runPromise(
        cleanupWorktrees(
          {
            fetchImpl: (): Promise<Response> => jsonFetch([]),
            readDir: (): Promise<readonly string[]> =>
              Promise.resolve([slug]),
            runGit,
            token: "tok",
          },
          {
            dryRun: false,
            repo: "acme-corp/helper-bot",
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
          path: join(root, slug),
        },
      ]);
    }));

  test("the sweep's own emptied slug container is not a stray — its contents still are", () =>
    withRealSlugDir(async (root, slug) => {
      // The sweep's own success end-state: every worktree removed, only the
      // emptied `<root>/<slug>/` container left. Pre-fix, the container
      // itself was reported as a `skipped-stray` on EVERY sweep — a
      // permanent false positive on a healthy layout, the same #71 class as
      // the ancestor case. (The sweep's on-disk listing is single-level
      // under the worktrees root, so only the container itself is ever a
      // candidate; its nested branch dirs never enter the stray set.)
      const runGit = fakeRunGit({ "worktree list": { stdout: "" } });

      const summary = await Effect.runPromise(
        cleanupWorktrees(
          {
            fetchImpl: (): Promise<Response> => jsonFetch([]),
            readDir: (dir: string): Promise<readonly string[]> =>
              dir === root
                ? Promise.resolve([slug])
                : Promise.resolve([]),
            runGit,
            token: "tok",
          },
          {
            dryRun: false,
            repo: "acme-corp/helper-bot",
            repoDir: root,
            repoSlug: slug,
            worktreesRoot: root,
          }
        )
      );

      // The emptied container is the sweep's own healthy end-state: no
      // outcome at all, not a stray on every run forever.
      expect(summary.outcomes).toEqual([]);
    }));

  test("a branch dir unknown to git IS reported as a stray in a slug-scoped sweep — the stray report is not dead", () =>
    withRealSlugDir(async (root, slug) => {
      // The pre-fix dead-report class: the CLI and the schedule ALWAYS pass
      // `repoSlug` (every real sweep is scoped), and the stray listing listed
      // the worktrees ROOT, whose only candidate under the scoped layout
      // `<root>/<slug>/<branch>` is the slug container itself — excluded as
      // the sweep's own healthy end-state. The stray set was therefore EMPTY
      // in every real invocation: a branch dir on disk that `git worktree
      // list` has no record of (the exact case the module doc promises to
      // report — e.g. one `rm -rf`'d behind git's back mid-add) was never
      // named. The listing must run at the SCOPE level, the per-branch
      // checkout dirs themselves.
      const runGit = fakeRunGit({ "worktree list": { stdout: "" } });

      const summary = await Effect.runPromise(
        cleanupWorktrees(
          {
            fetchImpl: (): Promise<Response> => jsonFetch([]),
            readDir: (dir: string): Promise<readonly string[]> =>
              // The on-disk truth: the slug container holds one branch dir
              // git does not know about (its worktree was `rm -rf`'d outside
              // git — the documented stray case).
              dir === join(root, slug)
                ? Promise.resolve(["stray-branch"])
                : dir === root
                  ? Promise.resolve([slug])
                  : Promise.resolve([]),
            runGit,
            token: "tok",
          },
          {
            dryRun: false,
            repo: "acme-corp/helper-bot",
            repoDir: root,
            repoSlug: slug,
            worktreesRoot: root,
          }
        )
      );

      // The unknown branch dir is named as the stray — reported, never
      // removed (dryRun:false, but strays are never removal candidates).
      expect(summary.outcomes).toEqual([
        {
          branch: "",
          decision: "skipped-stray",
          detail:
            "on disk but unknown to `git worktree list` — run `git worktree prune` or inspect manually",
          path: join(root, slug, "stray-branch"),
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


describe("cleanupWorktrees (ambient mode)", () => {
  test("sweeps with no token at all — the PR lookup goes bare and the closed-PR worktree is still removed", () =>
    withRealTmpDir(async (root) => {
      const path = join(root, "branch-a");
      const runGit = fakeRunGit({
        "status --porcelain": { stdout: "" },
        "worktree list": {
          stdout: `worktree ${path}\nHEAD abc\nbranch refs/heads/branch-a\n\n`,
        },
        "worktree remove": { ok: true },
      });
      let sawAuthorization = false;
      const fetchImpl = (url: string, init?: RequestInit): Promise<Response> => {
        if (!url.includes("/pulls?")) {
          return jsonFetch([]);
        }
        const headers = (init?.headers ?? {}) as Record<string, string>;
        sawAuthorization = "Authorization" in headers;
        return jsonFetch([{ number: 7, state: "closed" }]);
      };

      const summary = await Effect.runPromise(
        cleanupWorktrees(
          {
            fetchImpl,
            readDir: readDirWithBranchA,
            runGit,
            // NO token: ambient mode — the bare request carries whatever
            // credential the host attaches (or none; the test proves the
            // header contract and the sweep shape, not GitHub itself).
          },
          {
            dryRun: false,
            repo: "owner/repo",
            repoDir: root,
            worktreesRoot: root,
          }
        )
      );

      expect(sawAuthorization).toBe(false);
      expect(summary.outcomes).toEqual([
        {
          branch: "branch-a",
          decision: "removed",
          detail: "removed (PR #7 closed, tree clean)",
          path,
        },
      ]);
    }));

  test("a bare lookup GitHub refuses (401) is an error outcome per worktree, never a silent skip", () =>
    withRealTmpDir(async (root) => {
      const path = join(root, "branch-a");
      const runGit = fakeRunGit({
        "worktree list": {
          stdout: `worktree ${path}\nHEAD abc\nbranch refs/heads/branch-a\n\n`,
        },
      });
      const fetchImpl = (): Promise<Response> =>
        jsonFetch({ message: "Requires authentication" }, 401);

      const summary = await Effect.runPromise(
        cleanupWorktrees(
          {
            fetchImpl,
            readDir: readDirWithBranchA,
            runGit,
          },
          {
            dryRun: false,
            repo: "owner/repo",
            repoDir: root,
            worktreesRoot: root,
          }
        )
      );

      expect(summary.outcomes).toHaveLength(1);
      expect(summary.outcomes[0]?.decision).toBe("error");
      expect(summary.outcomes[0]?.detail).toContain("PR lookup failed");
      expect(summary.outcomes[0]?.detail).toContain(
        "Requires authentication"
      );
    }));
});

describe("PR lookup failure reporting", () => {
  test("a branch whose open PR sits past the first page of its history is kept, not removed — the PR lookup paginates", () =>
    withRealTmpDir(async (root) => {
      const path = join(root, "branch-a");
      let removed = false;
      const runGit = fakeRunGit({
        "status --porcelain": { stdout: "" },
        "worktree list": {
          stdout: `worktree ${path}\nHEAD abc\nbranch refs/heads/branch-a\n\n`,
        },
        "worktree remove": { ok: true },
      });
      // Page one: a FULL page of closed PRs (the newest, closed as
      // superseded). Page two: the still-open PR the branch was re-opened
      // from. Pre-fix: only page one was fetched — 100 closed entries fill
      // it — so the sweep saw the newest closed PR, removed the worktree,
      // and deleted the branch while its work was back in review.
      const fullClosedPage = Array.from(
        { length: 100 },
        (_, i): { number: number; state: "closed" } => ({
          number: 200 - i,
          state: "closed",
        })
      );
      const pages: ReadonlyArray<readonly unknown[]> = [
        fullClosedPage,
        [{ number: 5, state: "open" }],
      ];
      let call = 0;
      const fetchImpl = (url: string): Promise<Response> => {
        if (!url.includes("/pulls?")) {
          return jsonFetch([]);
        }
        const page = new URL(url).searchParams.get("page") ?? "1";
        expect(page).toBe(String(call + 1));
        const body = pages[call] ?? [];
        call += 1;
        return jsonFetch(body);
      };

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

      expect(removed).toBe(false);
      expect(call).toBe(2);
      expect(summary.outcomes).toEqual([
        {
          branch: "branch-a",
          decision: "skipped-open-pr",
          detail: "PR #5 is still open",
          path,
        },
      ]);
    }));

  test("a repoSlug option scopes the sweep to this repo's slug directory — a sibling repo's worktree is out of scope", () =>
    withRealSlugDir(async (root, slug) => {
      // The documented `<root>/<other-slug>/<branch>` layout for ANOTHER
      // repo's worktree, plus this repo's own slug dir with none in it.
      // Pre-fix: both were candidates, and the sweep ran its PR lookup (and
      // potentially `git worktree remove`) against this sweep's repo.
      const foreignPath = join(root, "other-repo-slug", "branch-a");
      await mkdir(foreignPath, { recursive: true });
      let removeCalled = false;
      const runGit = fakeRunGit({
        "status --porcelain": { stdout: "" },
        "worktree list": {
          stdout: `worktree ${foreignPath}\nHEAD abc\nbranch refs/heads/branch-a\n\n`,
        },
        "worktree remove": { ok: true },
      });
      const trackingRunGit = (args: readonly string[], cwd: string) => {
        if (args[0] === "worktree" && args[1] === "remove") {
          removeCalled = true;
        }
        return runGit(args, cwd);
      };

      const summary = await Effect.runPromise(
        cleanupWorktrees(
          {
            fetchImpl: (): Promise<Response> =>
              // A PR lookup against THIS repo would find a closed PR for
              // branch-a — the exact false removal signal for a foreign
              // repo's worktree the slug scoping must prevent.
              jsonFetch([{ number: 9, state: "closed" }]),
            readDir: async (dir: string) =>
              dir === root ? [slug, "other-repo-slug"] : [],
            runGit: trackingRunGit,
            token: "tok",
          },
          {
            dryRun: false,
            repo: "acme-corp/helper-bot",
            repoSlug: slug,
            repoDir: root,
            worktreesRoot: root,
          }
        )
      );

      // The foreign repo's worktree never appears, and nothing was removed.
      expect(removeCalled).toBe(false);
      expect(
        summary.outcomes.some((o) => o.path === foreignPath)
      ).toBe(false);
      expect(summary.gitListFailed).toBeUndefined();
      // The own (empty) slug container may be reported as a stray — an
      // informational line, never a deletion — but the FOREIGN slug dir is
      // out of scope entirely: it holds this sweep's own nothing, and the
      // scoped sweep never even lists it.
      expect(
        summary.outcomes.some(
          (o) =>
            o.path === join(root, "other-repo-slug") &&
            o.decision === "skipped-stray"
        )
      ).toBe(false);
    }));

  test("an HTTP error on the PR lookup (e.g. a 403 rate limit) is an error outcome, not skipped-no-pr", () =>
    withRealTmpDir(async (root) => {
      const path = join(root, "branch-a");
      const runGit = fakeRunGit({
        "worktree list": {
          stdout: `worktree ${path}\nHEAD abc\nbranch refs/heads/branch-a\n\n`,
        },
      });
      const fetchImpl = (): Promise<Response> =>
        jsonFetch({ message: "API rate limit exceeded" }, 403);

      const summary = await Effect.runPromise(
        cleanupWorktrees(
          {
            fetchImpl,
            readDir: readDirEmpty,
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

      // The branch state is unknown — the worktree is reported as an error and
      // left untouched, never silently skipped as if it had no PR.
      expect(summary.outcomes).toEqual([
        {
          branch: "branch-a",
          decision: "error",
          detail:
            // The lookup URL carries per_page=100 and page=1 (the paginated
            // walk) — the pre-fix unpaginated URL shape is pinned by no test.
            `PR lookup failed: GET https://api.github.com/repos/owner/repo/pulls?head=owner%3Abranch-a&state=all&per_page=100&page=1: API rate limit exceeded`,
          path,
        },
      ]);
    }));

  test("a branch name with a plus still matches its PR (the head filter is URL-encoded)", () =>
    withRealTmpDir(async (root) => {
      const path = join(root, "fix+lint");
      await mkdir(path);
      const runGit = fakeRunGit({
        "worktree list": {
          stdout: `worktree ${path}\nHEAD abc\nbranch refs/heads/fix+lint\n\n`,
        },
      });
      const fetchImpl = (url: string | URL): Promise<Response> => {
        // GitHub decodes an unencoded \+ in a query value as a space, so the
        // head filter must arrive percent-encoded to match the branch.
        const head = new URL(String(url)).searchParams.get("head");
        return Promise.resolve(
          jsonFetch(head === "owner:fix+lint" ? [{ number: 5, state: "closed" }] : [])
        );
      };

      const summary = await Effect.runPromise(
        cleanupWorktrees(
          {
            fetchImpl: fetchImpl as never,
            readDir: (): Promise<readonly string[]> => Promise.resolve([]),
            runGit,
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

      expect(summary.outcomes).toEqual([
        {
          branch: "fix+lint",
          decision: "removed",
          detail: "dry-run — would remove (PR #5 closed, tree clean)",
          path,
        },
      ]);
    }));

  test("a branch with an open PR is kept even when a newer PR for the same branch is closed", () =>
    withRealTmpDir(async (root) => {
      const path = join(root, "branch-a");
      let removed = false;
      const runGit = fakeRunGit({
        "status --porcelain": { stdout: "" },
        "worktree list": {
          stdout: `worktree ${path}\nHEAD abc\nbranch refs/heads/branch-a\n\n`,
        },
        "worktree remove": { ok: true },
      });
      // `state=all` pages come back newest-first: a PR closed as superseded
      // (#14) must not mask the still-open re-opened PR (#12) for the same
      // branch — keying on `page[0]` alone removes a worktree whose work is
      // back in review.
      const fetchImpl = (): Promise<Response> =>
        jsonFetch([
          {
            number: 14,
            state: "closed",
          },
          {
            number: 12,
            state: "open",
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

      expect(removed).toBe(false);
      expect(summary.outcomes).toEqual([
        {
          branch: "branch-a",
          decision: "skipped-open-pr",
          detail: "PR #12 is still open",
          path,
        },
      ]);
    }));
});

describe("locked and detached worktrees (the porcelain attributes git really emits)", () => {
  test("a locked worktree is skipped with a dedicated decision, never a `git worktree remove` error", () =>
    withRealTmpDir(async (root) => {
      // `git worktree add --lock` emits `locked <reason>` after the branch
      // line. `git worktree remove` refuses a locked worktree without
      // `--force --force`, so pre-fix a closed-PR clean-tree locked worktree
      // produced a permanent `[error] git worktree remove failed: ... is a
      // locked working tree` on EVERY sweep — reported, never actionable.
      const path = join(root, "branch-a");
      const runGit = fakeRunGit({
        "status --porcelain": { stdout: "" },
        "worktree list": {
          stdout: [
            `worktree ${path}`,
            "HEAD abc",
            "branch refs/heads/branch-a",
            "locked added with --lock",
            "",
          ].join("\n"),
        },
      });
      let lookedUpPr = false;
      const fetchImpl = (): Promise<Response> => {
        lookedUpPr = true;
        return jsonFetch([{ number: 7, state: "closed" }]);
      };

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

      // The lock wins before any PR lookup: no network round-trip, and the
      // decision names the unlock command the operator can run.
      expect(lookedUpPr).toBe(false);
      expect(summary.outcomes).toEqual([
        {
          branch: "branch-a",
          decision: "skipped-locked",
          detail:
            "locked worktree (git worktree unlock <path> to let the sweep manage it)",
          path,
        },
      ]);
    }));

  test("a locked worktree is skipped even with no lock reason on the line", () =>
    withRealTmpDir(async (root) => {
      // `git worktree lock` with no reason emits a bare `locked` line.
      const path = join(root, "branch-a");
      const runGit = fakeRunGit({
        "worktree list": {
          stdout: [
            `worktree ${path}`,
            "HEAD abc",
            "branch refs/heads/branch-a",
            "locked",
            "",
          ].join("\n"),
        },
      });

      const summary = await Effect.runPromise(
        cleanupWorktrees(
          {
            fetchImpl: (): Promise<Response> => jsonFetch([]),
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
          decision: "skipped-locked",
          detail:
            "locked worktree (git worktree unlock <path> to let the sweep manage it)",
          path,
        },
      ]);
    }));

  test("a detached worktree is reported as detached, not as a stray unknown to git", () =>
    withRealTmpDir(async (root) => {
      // A detached worktree (git worktree add --detach) emits a `detached`
      // line and NO branch line. Pre-fix the parser dropped the entry
      // entirely, so the on-disk directory fell through to the stray
      // report — whose detail ("unknown to `git worktree list`", "run
      // `git worktree prune`") was factually wrong for a worktree git
      // fully knows about, on every sweep.
      const path = join(root, "branch-a");
      const runGit = fakeRunGit({
        "worktree list": {
          stdout: [
            `worktree ${path}`,
            "HEAD abc",
            "detached",
            "",
          ].join("\n"),
        },
      });

      const summary = await Effect.runPromise(
        cleanupWorktrees(
          {
            fetchImpl: (): Promise<Response> => jsonFetch([]),
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
          decision: "skipped-detached",
          detail:
            "detached HEAD (no branch checked out) — nothing to match a PR against",
          path,
        },
      ]);
      expect(
        summary.outcomes.some((o) => o.decision === "skipped-stray")
      ).toBe(false);
    }));
});
