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
import { join, relative, sep } from "node:path";

import { Effect, Schema } from "effect";

import type { FetchLike, RunGit } from "./commit-api-core.ts";

import { CommitApiError, GITHUB_API, defaultRunGit, ghJson } from "./commit-api-core.ts";

export type WorktreeDecision =
  | "removed"
  | "skipped-dirty"
  | "skipped-locked"
  | "skipped-open-pr"
  | "skipped-no-pr"
  | "skipped-stray"
  | "skipped-detached"
  | "skipped-bare"
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
  /**
   * Only worktrees under `<worktreesRoot>/<repo-slug>/` are candidates —
   * the layout this feature's own worktree-creation flow writes. The sweep
   * never touches another repo's slug directory: a branch name is unique
   * per-repo (and git branch names may collide across repos), so a PR lookup
   * against `--repo other/repo` for a worktree that belongs to a sibling
   * repo is not a removal signal for it. When omitted, the sweep stays
   * scoped by `git worktree list` output alone (a branch whose repo cannot
   * be assumed is reported, never removed).
   */
  readonly repoSlug?: string;
}

export interface CleanupDeps {
  readonly runGit?: RunGit;
  readonly fetchImpl?: FetchLike;
  readonly readDir?: (path: string) => Promise<readonly string[]>;
  /** True when `path` holds no entries at all. Defaults to a real `readdir`;
   *  an unreadable path answers false (still reported). */
  readonly isEmptyDir?: (path: string) => Promise<boolean>;
  /**
   * Bearer token for the PR lookup. Optional for ambient mode (`GH_APP_ID`
   * unset): the lookup then goes bare, and the host's egress proxy attaches
   * the workspace credential — the same ambient REST discipline the feature
   * prompt teaches and `gh-auth-health` implements. A bare lookup GitHub
   * answers 401/403 (no ambient credential) surfaces as an error outcome
   * per worktree, never a silent skip.
   */
  readonly token?: string;
}

export interface CleanupSummary {
  readonly outcomes: readonly WorktreeOutcome[];
  /** True when the sweep could not run: `git worktree list` itself failed. */
  readonly gitListFailed?: boolean;
}

const defaultReadDir = async (path: string): Promise<readonly string[]> => {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
};

const defaultIsEmptyDir = (path: string): Promise<boolean> =>
  readdir(path).then(
    (entries) => entries.length === 0,
    () => false
  );

/** One `git worktree list --porcelain` entry: a worktree path plus its
 *  checked-out branch and the optional attributes git reports for it. */
interface TrackedWorktree {
  readonly path: string;
  /** Undefined for a detached/bare entry (no branch checked out). */
  readonly branch?: string;
  /** True when the block carries a `locked` line (git's `--lock` marker). */
  readonly locked?: boolean;
  /** True when the block carries a `detached` line (no branch checked out). */
  readonly detached?: boolean;
  /** True when the block carries a `bare` line (a bare repository). */
  readonly bare?: boolean;
}

/**
 * Parse `git worktree list --porcelain` output. Each worktree is a blank-line
 * separated block; `branch refs/heads/<name>` is present for a normal
 * checkout, absent for a detached/bare entry. A detached entry carries no
 * branch to match a PR against, so it stays out of the removal candidates —
 * but it is STILL a worktree git knows about, so it must stay out of the
 * stray set too (a stray is by definition unknown to `git worktree list`).
 * The `locked`/`detached`/`bare` attributes travel with every entry so callers
 * can tell a deliberate operator lock from an unknown directory.
 */
export const parseWorktreeList = (
  output: string
): readonly TrackedWorktree[] => {
  const entries: TrackedWorktree[] = [];
  let path: string | undefined;
  let branch: string | undefined;
  let locked = false;
  let detached = false;
  let bare = false;
  const flush = (): void => {
    if (path !== undefined) {
      entries.push({
        ...(branch === undefined ? {} : { branch }),
        ...(bare ? { bare: true } : {}),
        ...(detached ? { detached: true } : {}),
        ...(locked ? { locked: true } : {}),
        path,
      });
    }
    path = undefined;
    branch = undefined;
    locked = false;
    detached = false;
    bare = false;
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
    if (line === "detached") {
      detached = true;
      continue;
    }
    if (line === "bare") {
      bare = true;
      continue;
    }
    if (line.startsWith("locked")) {
      locked = true;
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

/** The PR lookup failed: a network error or an HTTP error status (403 rate
 *  limit, 5xx, …). Distinct from "no PR for this branch", which is a real
 *  answer, so the removal decision can tell the two apart. */
class PrLookupError extends Error {
  constructor(
    readonly status: number | undefined,
    message: string
  ) {
    super(message);
    this.name = "PrLookupError";
  }
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

/** `GET /repos/{repo}/pulls?head={owner}:{branch}&state=all` — the branch's
 *  deciding PR, or `undefined` when none exists. A branch can carry several
 *  PRs across its history (a PR closed as superseded, then a fresh one
 *  re-opened from the same branch), and GitHub returns the pages newest-first:
 *  keying on the first entry alone would let a NEW closed PR mask an OLDER
 *  still-open one and remove a worktree whose work is back in review. An open
 *  PR anywhere in the pages always wins; with none open, the newest entry
 *  decides. The pages are walked until one comes back short (the same
 *  short-page-is-last-page discipline as the installation discovery in
 *  `gh-app-github-api.ts`): a branch whose PR history crosses the page
 *  boundary — the newest closed PR on page one, the still-open re-opened PR
 *  behind it — is decided by page one alone otherwise, and its worktree is
 *  removed mid-review. GitHub's PR `state` is only ever "open"/"closed";
 *  `merged_at` doesn't change the removal decision, so it's not read here. */

/** One page of the PR list: 100 entries, the largest page GitHub serves. */
const PULLS_PAGE_SIZE = 100;

/**
 * How long one page of the PR lookup may take before the sweep stops waiting.
 * Pre-fix a hung connection to `api.github.com` (a dropped route, a wedged
 * proxy) left the whole sweep pending forever — `evaluateWorktree`'s
 * `{ concurrency: 1 }` queue stalled behind it, every later fire was skipped
 * as still-running, and the worktrees the schedule exists to reclaim simply
 * accumulated. The deadline turns "no answer" into the same `PrLookupError`
 * channel a 403 rate limit already uses: an `error` outcome per worktree,
 * reported, never a silent hang.
 */
const PR_LOOKUP_TIMEOUT_MS = 15_000;

const findPrForBranch = Effect.fn("CleanupWorktrees.findPrForBranch")(
  function* (input: {
    readonly fetchImpl: FetchLike;
    /** Optional for ambient mode — see CleanupDeps.token. */
    readonly token?: string;
    readonly repo: string;
    readonly branch: string;
  }) {
    const [owner = ""] = input.repo.split("/");
    // URL-encode the query value: a branch name may contain characters a query
    // string reserves (`+` decodes as a space, `&`/`#`/`%` break the URL
    // itself), and an unencoded `+` silently fails the head= filter — the
    // sweep then reports "no PR found" and never cleans the worktree. The repo
    // stays a raw `owner/repo` path segment: GitHub's route matches the
    // separator literally, and %2F-encoding it answers 404 (verified live).
    const url = `${GITHUB_API}/repos/${input.repo}/pulls?head=${encodeURIComponent(
      `${owner}:${input.branch}`
    )}&state=all&per_page=${PULLS_PAGE_SIZE}`;
    /** One page of the branch's PRs, or `undefined` when the response was a
     *  shape GitHub's own schema never promised (an unexpected `state` value)
     *  — degraded to "no PR found", the branch that keeps the worktree. */
    const fetchPage = (
      page: number
    ): Effect.Effect<readonly PrLookup[] | undefined, PrLookupError> =>
      ghJson({
        fetchImpl: input.fetchImpl,
        method: "GET",
        schema: PullRequestPage,
        token: input.token,
        url: `${url}&page=${page}`,
      }).pipe(
        Effect.catchIf(
          (error): error is CommitApiError =>
            error instanceof CommitApiError && error.stage !== "http",
          () => Effect.succeed<readonly PrLookup[] | undefined>(undefined)
        ),
        // A network failure or an HTTP error status (403 rate limit, 5xx) is
        // NOT "no PR": it is raised so the sweep reports an error outcome
        // rather than silently skipping a worktree whose PR state is unknown.
        Effect.mapError(
          (error: CommitApiError) =>
            new PrLookupError(error.status, error.message)
        )
      );
    // Newest-first across pages: the first entry of the first non-empty page
    // is the deciding PR when no page holds an open one.
    let newest: PrLookup | undefined;
    for (let page = 1; ; page += 1) {
      const entries = yield* fetchPage(page).pipe(
        // Bound the wait: a page that never settles is a lookup failure, not
        // an answer — see PR_LOOKUP_TIMEOUT_MS.
        Effect.timeoutOrElse({
          duration: PR_LOOKUP_TIMEOUT_MS,
          orElse: () =>
            Effect.fail(
              new PrLookupError(
                PR_LOOKUP_TIMEOUT_MS / 1000,
                `GET pulls page ${page} did not answer within ${PR_LOOKUP_TIMEOUT_MS / 1000}s`
              )
            ),
        })
      );
      // A degraded page (unexpected shape) is "no PR found" — stop here.
      if (entries === undefined) {
        break;
      }
      // An open PR anywhere in the pages always wins — stop the walk.
      const open = entries.find((pr) => pr.state === "open");
      if (open !== undefined) {
        return open;
      }
      // An empty page is "no PR for this branch" beyond this point — a real
      // answer, not an error.
      if (entries.length === 0) {
        break;
      }
      if (newest === undefined) {
        newest = entries[0];
      }
      // A short page is the last page; a full one may have a deciding open PR
      // behind it — keep walking.
      if (entries.length < PULLS_PAGE_SIZE) {
        break;
      }
    }
    return newest;
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
  branch: tracked.branch ?? "",
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
  // A detached entry never reaches here (no branch → skipped up front), but
  // the type system cannot see that, so the undefined case is a no-op.
  if (tracked.branch !== undefined) {
    runGit(["branch", "-D", tracked.branch], options.repoDir);
  }
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
    /** Optional for ambient mode — see CleanupDeps.token. */
    readonly token?: string;
  }) {
    const { tracked, options, runGit, fetchImpl, token } = input;
    // A locked worktree is an explicit operator signal ("do not touch this
    // one" — `git worktree add --lock`). `git worktree remove` refuses it
    // without `--force --force`, so pre-fix a locked worktree whose PR was
    // closed and tree clean turned into a permanent `[error] git worktree
    // remove failed: ... is a locked working tree` line on EVERY sweep —
    // reported, never actionable, never resolving. The lock wins: skip with a
    // dedicated decision before any PR lookup or git probe, leaving the
    // unlock to the operator (the only one who can legitimately lift it).
    if (tracked.locked === true) {
      return outcomeFor(
        tracked,
        "skipped-locked",
        "locked worktree (git worktree unlock <path> to let the sweep manage it)"
      );
    }
    // A detached worktree (no branch checked out) has no branch to match a
    // PR against. Pre-fix the parser dropped the whole entry, so the
    // worktree fell through to the stray report — with a detail that was
    // factually wrong ("unknown to git worktree list") on a worktree git
    // fully knows about, inviting an operator to "inspect manually" a
    // healthy checkout on every sweep. Report it for what it is instead.
    if (tracked.branch === undefined) {
      // A bare repository (the `bare` porcelain attribute) is not a detached
      // HEAD: it has no working tree at all, and `git worktree remove` refuses
      // it outright. Report it for what it is — the same factually-right-detail
      // discipline as the detached branch below; pre-fix a bare entry carried
      // the detached branch's detail, inviting an operator to "inspect" a
      // healthy bare repo on every sweep.
      if (tracked.bare === true) {
        return outcomeFor(
          tracked,
          "skipped-bare",
          "bare repository (no working tree) — nothing to match a PR against"
        );
      }
      return outcomeFor(
        tracked,
        "skipped-detached",
        "detached HEAD (no branch checked out) — nothing to match a PR against"
      );
    }
    // A lookup failure (403 rate limit, 5xx, network) is NOT "no PR": the
    // branch's PR state is unknown, so the worktree is reported as an error
    // and left untouched — never silently skipped as if it had no PR.
    const pr = yield* findPrForBranch({
      branch: tracked.branch,
      fetchImpl,
      repo: options.repo,
      token,
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed<WorktreeOutcome>(
          outcomeFor(
            tracked,
            "error",
            `PR lookup failed: ${error instanceof Error ? error.message : String(error)}`
          )
        )
      )
    );
    if (pr !== undefined && "decision" in pr) {
      return pr;
    }
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

/** Directories on disk under the swept scope that `git worktree list` has no
 *  record of — reported, never acted on directly (see module doc). The sweep
 *  lists ONE directory level: `scopeDir` when the sweep is slug-scoped (the
 *  CLI and schedule always are — the per-branch checkouts live under
 *  `<worktrees-root>/<repo-slug>/`, so THAT is the level whose on-disk dirs
 *  must be checked against `git worktree list`), else `resolvedRoot` (the
 *  historical unscoped behavior). Pre-fix this always listed the worktrees
 *  root: a scoped sweep's only top-level candidate was the slug container
 *  itself — excluded as the sweep's own healthy end-state — so the stray
 *  report was EMPTY in every real invocation, and a branch dir unknown to
 *  git (the exact case the report exists for) was never named. A directory
 *  that is an ANCESTOR of a tracked worktree is not a stray: `git worktree
 *  list` tracks the per-branch checkout, never a container it lives in —
 *  without this exclusion every healthy layout was reported as a false stray
 *  on every sweep. The sweep's own `scopeDir` container is never a stray
 *  either (its contents stay in scope). Both sides of the comparison go
 *  through `resolvedRoot`-style realpath resolution so a symlinked root
 *  (e.g. macOS `/tmp` → `/private/tmp`) can't cause the same worktree to be
 *  reported twice. */
const findStrayDirs = Effect.fn("CleanupWorktrees.findStrayDirs")(
  function* (input: {
    readonly resolvedRoot: string;
    readonly tracked: readonly TrackedWorktree[];
    readonly readDir: (path: string) => Promise<readonly string[]>;
    readonly isEmptyDir: (path: string) => Promise<boolean>;
    /** Only strays under this directory are reported. Omitted → every stray
     *  under `resolvedRoot` (the historical behavior). */
    readonly scopeDir?: string;
  }) {
    const trackedPaths = new Set(input.tracked.map((entry) => entry.path));
    // List the SCOPE level, not the root: a slug-scoped sweep checks its own
    // slug dir's children (the per-branch layout); an unscoped sweep keeps
    // listing the root (the historical behavior the unscoped tests pin).
    const listDir = input.scopeDir ?? input.resolvedRoot;
    const onDisk = yield* Effect.promise(() => input.readDir(listDir));
    const candidates = onDisk
      .map((name) => join(listDir, name))
      .filter(
        (path) =>
          input.scopeDir === undefined ||
          path === input.scopeDir ||
          path.startsWith(`${input.scopeDir}${sep}`)
      )
      .filter(
        (path) =>
          // The sweep's own slug container is never a stray. The flow's own
          // layout is `<root>/<slug>/<branch>`: `git worktree list` tracks
          // the per-branch checkout, never the container, and once every
          // branch's worktree is removed (the sweep's own success path) only
          // the emptied container remains — a healthy layout the sweep
          // would otherwise report as a stray on EVERY subsequent run,
          // exactly the #71 false-stray class for the ancestor case. Its
          // CONTENTS stay in scope: a stray branch dir under it is still
          // reported; only the container itself is excluded.
          path !== input.scopeDir
      )
      .filter((path) => !trackedPaths.has(path))
      .filter(
        (path) =>
          // Keep the exclusion tight: a container holds tracked worktrees
          // UNDER it, as a proper path prefix (not a string prefix —
          // `/a/b` is not an ancestor of `/a/bc`).
          !Array.from(trackedPaths).some((tracked) =>
            tracked.startsWith(`${path}${sep}`)
          )
      );
    // A worktree checkout is never empty (it always holds its `.git` link):
    // an empty directory is the namespace container `git worktree remove`
    // leaves behind for a slash-bearing branch (`fix/` after `fix/topic`),
    // which `git worktree prune` can never clear — not a stray worktree.
    const empty = yield* Effect.promise(() =>
      Promise.all(candidates.map((path) => input.isEmptyDir(path)))
    );
    return candidates
      .filter((_path, index) => empty[index] !== true)
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
 *  The repo checkout itself (`resolvedRepoDir`, resolved the same way) is
 *  ALWAYS excluded too — the module doc promises it "never appears in the
 *  result", but a checkout that sits under the worktrees root (an unusual
 *  layout, or a `--worktrees-root` pointed at a directory containing it) is
 *  otherwise admitted as a candidate, and the sweep would try `git worktree
 *  remove` on the live checkout.
 *  Normalizing here (not just checking containment) keeps every downstream
 *  comparison — including `findStrayDirs`'s against real on-disk paths —
 *  working off the same resolved form, so a symlinked root (e.g. macOS `/tmp`
 *  → `/private/tmp`) can't cause the same worktree to be reported twice. */
const resolveWithinRoot = Effect.fn("CleanupWorktrees.resolveWithinRoot")(
  function* (
    tracked: readonly TrackedWorktree[],
    resolvedRoot: string,
    resolvedRepoDir: string
  ) {
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
    return resolved.filter(
      (entry) =>
        // The repo checkout is never a removal candidate (see above). Only
        // the checkout itself is excluded — NOT everything under it: in the
        // tests (and a `--repo-dir` == `--worktrees-root` layout) the root is
        // the checkout, and its sibling worktrees are the whole point of the
        // sweep.
        entry.path !== resolvedRepoDir &&
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
    const isEmptyDir = deps.isEmptyDir ?? defaultIsEmptyDir;

    const resolvedRoot = yield* toRealPath(options.worktreesRoot);
    // The repo checkout git runs from — resolved the same way as every other
    // path, so a symlinked checkout can't dodge the exclusion.
    const resolvedRepoDir = yield* toRealPath(options.repoDir);
    let worktreeScope: readonly TrackedWorktree[] | undefined;

    runGit(["worktree", "prune"], options.repoDir);
    const listed = runGit(["worktree", "list", "--porcelain"], options.repoDir);
    if (!listed.ok) {
      const detail = listed.stderr.trim();
      const failure = outcomeFor(
        {
          branch: "",
          path: options.worktreesRoot,
        },
        "error",
        `git worktree list failed${detail === "" ? "" : `: ${detail}`}`
      );
      return {
        gitListFailed: true,
        outcomes: [failure],
      } satisfies CleanupSummary;
    }
    const tracked = parseWorktreeList(listed.stdout);
    const resolvedSlugDir =
      options.repoSlug !== undefined
        ? yield* toRealPath(join(options.worktreesRoot, options.repoSlug))
        : undefined;
    const withinRoot = yield* resolveWithinRoot(
      tracked,
      resolvedRoot,
      resolvedRepoDir
    );
    if (resolvedSlugDir !== undefined) {
      // Scoped to one repo's slug directory: a worktree under a different
      // slug directory belongs to another repo — out of scope: reported by
      // neither the outcome list nor the stray sweep below.
      const scoped = withinRoot.filter((entry) => {
        const rel = relative(resolvedSlugDir, entry.path);
        return (
          (rel !== "" && !rel.startsWith("..")) ||
          entry.path === resolvedSlugDir
        );
      });
      worktreeScope = scoped;
    }

    const outcomes = yield* Effect.all(
      (worktreeScope ?? withinRoot).map((entryTracked) =>
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
      isEmptyDir,
      readDir,
      resolvedRoot,
      scopeDir: resolvedSlugDir,
      tracked: worktreeScope ?? withinRoot,
    });
    return { outcomes: [...outcomes, ...strays] } satisfies CleanupSummary;
  }
);
