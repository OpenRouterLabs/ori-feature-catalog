/**
 * cleanup-worktrees-core.ts — the pure sweep logic behind `cleanup-worktrees.ts`
 * (the CLI script) and the `worktree-cleanup` schedule.
 *
 * Deliberately free of any `ori` import so the sweep is unit-testable in
 * isolation with injected fakes; both callers wire the real `git`/`fetch`/`fs`
 * seams. Split out of `cleanup-worktrees.ts` purely to keep each module under
 * the file-length lint budget, matching `commit-api-core.ts` / `commit-flow.ts`.
 *
 * # The safety model
 *
 * A worktree is only removed when BOTH hold:
 *   1. Its branch's PR (matched by head) is merged or closed — never open, and
 *      never "no PR found at all" (an abandoned branch with no PR is reported,
 *      not deleted, since there's no signal the work is actually done).
 *   2. `git status --porcelain` in the worktree is empty — no uncommitted work.
 *
 * Everything else is reported with a reason and left untouched. A directory
 * under the worktrees root that `git worktree list` doesn't know about (e.g. one
 * `rm -rf`'d outside git) is reported as a "stray" and never touched directly —
 * `git worktree prune` (run once per sweep) is the only thing that clears git's
 * own bookkeeping for a vanished directory. A worktree `git` tracks OUTSIDE the
 * worktrees root — most notably the repo checkout itself — is simply out of
 * scope: it never appears in the result at all, since it was never a candidate.
 */

import { readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

import { Effect, Schema } from "effect";

import type { FetchLike, RunGit } from "./commit-api-core.ts";

import { GITHUB_API, defaultRunGit, ghJson } from "./commit-api-core.ts";

export type WorktreeDecision =
  | "removed"
  | "skipped-dirty"
  | "skipped-open-pr"
  | "skipped-no-pr"
  | "skipped-stray"
  | "error";

export interface WorktreeOutcome {
  readonly path: string;
  readonly branch: string;
  readonly decision: WorktreeDecision;
  /** Human-readable detail (PR number/state, error message, etc.). Never secret material. */
  readonly detail: string;
}

export interface CleanupOptions {
  readonly repo: string;
  /** A real git working directory (the repo checkout) — `git worktree
   *  list`/`prune`/`remove` and `git branch -D` run with this as `cwd`, since
   *  `worktreesRoot` is just a container of checkouts, never itself a repo. */
  readonly repoDir: string;
  readonly worktreesRoot: string;
  readonly dryRun: boolean;
}

export interface CleanupDeps {
  readonly runGit?: RunGit;
  readonly fetchImpl?: FetchLike;
  readonly readDir?: (path: string) => Promise<readonly string[]>;
  readonly token: string;
}

export interface CleanupSummary {
  readonly outcomes: readonly WorktreeOutcome[];
}

const defaultReadDir = async (path: string): Promise<readonly string[]> => {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
};

/** One `git worktree list --porcelain` entry: a worktree path plus its checked-out branch. */
interface TrackedWorktree {
  readonly path: string;
  readonly branch: string;
}

/**
 * Parse `git worktree list --porcelain` output. Each worktree is a blank-line
 * separated block; `branch refs/heads/<name>` is present for a normal
 * checkout, absent for a detached/bare entry (skipped — nothing to match a PR
 * against).
 */
export const parseWorktreeList = (
  output: string
): readonly TrackedWorktree[] => {
  const entries: TrackedWorktree[] = [];
  let path: string | undefined;
  let branch: string | undefined;
  const flush = (): void => {
    if (path !== undefined && branch !== undefined) {
      entries.push({
        branch,
        path,
      });
    }
    path = undefined;
    branch = undefined;
  };
  for (const line of output.split("\n")) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
      continue;
    }
    if (line.startsWith("branch refs/heads/")) {
      branch = line.slice("branch refs/heads/".length);
    }
  }
  flush();
  return entries;
};

/** Resolve `path` to its real path as an Effect, tolerating a path that
 *  doesn't exist (e.g. a fake path in a test) by falling back to the input
 *  unchanged rather than failing. `Effect.tryPromise` (not `Effect.promise`,
 *  which treats a rejection as an unrecoverable defect) routes `realpath`'s
 *  ENOENT into the recoverable channel `orElseSucceed` catches. */
const toRealPath = Effect.fn("CleanupWorktrees.toRealPath")(function* (
  path: string
) {
  return yield* Effect.tryPromise(() => realpath(path)).pipe(
    Effect.orElseSucceed(() => path)
  );
});

/** True when already-real-pathed `path` is `resolvedRoot` or a descendant of it. */
const isUnderResolvedRoot = (path: string, resolvedRoot: string): boolean =>
  path === resolvedRoot || path.startsWith(`${resolvedRoot}${sep}`);

interface PrLookup {
  readonly state: "open" | "closed";
  readonly number: number;
}

/** The two fields of a `GET /repos/{repo}/pulls` entry the removal decision
 *  reads. A `state` outside the pair below is a shape this code has never
 *  reasoned about; the tolerance at the call site turns it into "no PR found",
 *  which keeps the worktree. */
const PullRequestPage = Schema.Array(
  Schema.Struct({
    number: Schema.Number,
    state: Schema.Literals(["open", "closed"]),
  })
);

/** `GET /repos/{repo}/pulls?head={owner}:{branch}&state=all` — the most recent
 *  PR for `branch`, or `undefined` when none exists. GitHub's PR `state` is
 *  only ever "open"/"closed"; `merged_at` doesn't change the removal decision,
 *  so it's not read here. */
const findPrForBranch = Effect.fn("CleanupWorktrees.findPrForBranch")(
  function* (input: {
    readonly fetchImpl: FetchLike;
    readonly token: string;
    readonly repo: string;
    readonly branch: string;
  }) {
    const [owner = ""] = input.repo.split("/");
    const url = `${GITHUB_API}/repos/${input.repo}/pulls?head=${owner}:${input.branch}&state=all`;
    return yield* ghJson({
      fetchImpl: input.fetchImpl,
      method: "GET",
      schema: PullRequestPage,
      token: input.token,
      url,
    }).pipe(
      // An empty page is "no PR for this branch", which is a real answer here —
      // not the decode failure the tolerance below absorbs.
      Effect.map((page): PrLookup | undefined =>
        page.length === 0 ? undefined : page[0]
      ),
      Effect.orElseSucceed((): PrLookup | undefined => undefined)
    );
  }
);

/** True when `git status --porcelain` in `worktreePath` reports no changes. */
const isTreeClean = (worktreePath: string, runGit: RunGit): boolean => {
  const result = runGit(["status", "--porcelain"], worktreePath);
  return result.ok && result.stdout.trim() === "";
};

/** Build a `WorktreeOutcome` for `tracked` — cuts the four-field boilerplate
 *  every decision branch below would otherwise repeat. */
const outcomeFor = (
  tracked: TrackedWorktree,
  decision: WorktreeDecision,
  detail: string
): WorktreeOutcome => ({
  branch: tracked.branch,
  decision,
  detail,
  path: tracked.path,
});

/** Remove `tracked`'s worktree and (best-effort) its now-served branch. */
const removeWorktree = (input: {
  readonly tracked: TrackedWorktree;
  readonly options: CleanupOptions;
  readonly runGit: RunGit;
  readonly prNumber: number;
}): WorktreeOutcome => {
  const { tracked, options, runGit, prNumber } = input;
  const removed = runGit(["worktree", "remove", tracked.path], options.repoDir);
  if (!removed.ok) {
    return outcomeFor(
      tracked,
      "error",
      `git worktree remove failed: ${removed.stderr.trim()}`
    );
  }
  // Best-effort: the branch has served its purpose once its PR merged/closed.
  // "branch not found" (already deleted, e.g. by a squash-merge cleanup) is
  // not an error here — the goal (branch gone) already holds.
  runGit(["branch", "-D", tracked.branch], options.repoDir);
  return outcomeFor(
    tracked,
    "removed",
    `removed (PR #${prNumber} closed, tree clean)`
  );
};

/** Decide and (unless `options.dryRun`) act on one tracked worktree. Assumes
 *  `tracked` already passed the containment check against the resolved root
 *  (done once, up front, in `cleanupWorktrees` — not re-checked per worktree). */
const evaluateWorktree = Effect.fn("CleanupWorktrees.evaluateWorktree")(
  function* (input: {
    readonly tracked: TrackedWorktree;
    readonly options: CleanupOptions;
    readonly runGit: RunGit;
    readonly fetchImpl: FetchLike;
    readonly token: string;
  }) {
    const { tracked, options, runGit, fetchImpl, token } = input;
    const pr = yield* findPrForBranch({
      branch: tracked.branch,
      fetchImpl,
      repo: options.repo,
      token,
    });
    if (pr === undefined) {
      return outcomeFor(
        tracked,
        "skipped-no-pr",
        "no PR found for this branch"
      );
    }
    if (pr.state === "open") {
      return outcomeFor(
        tracked,
        "skipped-open-pr",
        `PR #${pr.number} is still open`
      );
    }
    if (!isTreeClean(tracked.path, runGit)) {
      return outcomeFor(
        tracked,
        "skipped-dirty",
        `PR #${pr.number} is closed, but the worktree has uncommitted changes`
      );
    }
    if (options.dryRun) {
      return outcomeFor(
        tracked,
        "removed",
        `dry-run — would remove (PR #${pr.number} closed, tree clean)`
      );
    }
    return removeWorktree({
      options,
      prNumber: pr.number,
      runGit,
      tracked,
    });
  }
);

/** Directories on disk under `resolvedRoot` that `git worktree list` has no
 *  record of — reported, never acted on directly (see module doc). Both sides
 *  of the comparison go through `resolvedRoot` so a symlinked root (e.g. macOS
 *  `/tmp` → `/private/tmp`) can't cause the same worktree to be reported twice. */
const findStrayDirs = Effect.fn("CleanupWorktrees.findStrayDirs")(
  function* (input: {
    readonly resolvedRoot: string;
    readonly tracked: readonly TrackedWorktree[];
    readonly readDir: (path: string) => Promise<readonly string[]>;
  }) {
    const trackedPaths = new Set(input.tracked.map((entry) => entry.path));
    const onDisk = yield* Effect.promise(() =>
      input.readDir(input.resolvedRoot)
    );
    return onDisk
      .map((name) => join(input.resolvedRoot, name))
      .filter((path) => !trackedPaths.has(path))
      .map(
        (path): WorktreeOutcome => ({
          branch: "",
          decision: "skipped-stray",
          detail:
            "on disk but unknown to `git worktree list` — run `git worktree prune` or inspect manually",
          path,
        })
      );
  }
);

/** Real-path each `tracked` entry and keep only those really under
 *  `resolvedRoot` — everything else (the repo checkout itself, or anything
 *  unexpected) is simply out of scope for this sweep, not an error.
 *  Normalizing here (not just checking containment) keeps every downstream
 *  comparison — including `findStrayDirs`'s against real on-disk paths —
 *  working off the same resolved form, so a symlinked root (e.g. macOS `/tmp`
 *  → `/private/tmp`) can't cause the same worktree to be reported twice. */
const resolveWithinRoot = Effect.fn("CleanupWorktrees.resolveWithinRoot")(
  function* (tracked: readonly TrackedWorktree[], resolvedRoot: string) {
    const resolved = yield* Effect.all(
      tracked.map((entry) =>
        toRealPath(entry.path).pipe(
          Effect.map((path) => ({
            ...entry,
            path,
          }))
        )
      )
    );
    return resolved.filter((entry) =>
      isUnderResolvedRoot(entry.path, resolvedRoot)
    );
  }
);

/**
 * Sweep every worktree `git` tracks under `options.worktreesRoot`, removing
 * (unless `options.dryRun`) any whose branch has a merged/closed PR and a clean
 * tree. Always runs `git worktree prune` first so stale metadata for
 * already-vanished directories doesn't linger, then reports (never deletes)
 * any on-disk directory `git worktree list` doesn't recognize. Anything `git`
 * tracks outside `options.worktreesRoot` (e.g. the repo checkout itself) is
 * simply not swept — it never appears in the result.
 */
export const cleanupWorktrees = Effect.fn("CleanupWorktrees.cleanupWorktrees")(
  function* (deps: CleanupDeps, options: CleanupOptions) {
    const runGit = deps.runGit ?? defaultRunGit;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const readDir = deps.readDir ?? defaultReadDir;

    const resolvedRoot = yield* toRealPath(options.worktreesRoot);

    runGit(["worktree", "prune"], options.repoDir);
    const listed = runGit(["worktree", "list", "--porcelain"], options.repoDir);
    const tracked = listed.ok ? parseWorktreeList(listed.stdout) : [];
    const withinRoot = yield* resolveWithinRoot(tracked, resolvedRoot);

    const outcomes = yield* Effect.all(
      withinRoot.map((entryTracked) =>
        evaluateWorktree({
          fetchImpl,
          runGit,
          token: deps.token,
          tracked: entryTracked,
          options,
        })
      ),
      { concurrency: 1 }
    );

    const strays = yield* findStrayDirs({
      readDir,
      resolvedRoot,
      tracked: withinRoot,
    });
    return { outcomes: [...outcomes, ...strays] } satisfies CleanupSummary;
  }
);
