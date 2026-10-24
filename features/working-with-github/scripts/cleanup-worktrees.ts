#!/usr/bin/env bun
/**
 * cleanup-worktrees.ts — remove worktrees under `/tmp/worktrees/<slug>/` whose
 * self-modification work is actually done.
 *
 * # When to use this
 *
 * The worktree-first workflow in this feature's prompt (see "Modifying your own
 * code") ends its last step with a single `git worktree remove "$WT"` — but
 * that line never runs if the process crashes, gets killed, or a PR is merged
 * or closed by someone else after the run has moved on. Worktrees accumulate
 * under `/tmp/worktrees/` with nothing to sweep them. Run this to clean up the
 * ones that are safe to remove, and see a report on the ones that aren't.
 *
 * # The safety model
 *
 * A worktree is only removed when BOTH hold: its branch has a merged-or-closed
 * PR (never open, never "no PR at all" — an abandoned branch with no PR is
 * reported, not deleted, since nothing signals the work is done), AND its tree
 * is clean (`git status --porcelain` is empty — no uncommitted work). Every
 * other case (open PR, no PR found, dirty tree) is reported with a reason and
 * left untouched. A directory on disk that `git worktree list` doesn't
 * recognize is reported as a "stray", never deleted directly.
 *
 * # Usage
 *
 *   bun features/working-with-github/scripts/cleanup-worktrees.ts
 *   bun features/working-with-github/scripts/cleanup-worktrees.ts --dry-run
 *   bun features/working-with-github/scripts/cleanup-worktrees.ts --repo owner/repo
 *
 * `--repo` defaults to `$GITHUB_REPO` — only that repo's own slug directory is
 * swept. Cleaning up worktrees for an upstream composed-feature fix needs an
 * explicit `--repo owner/repo` (mirroring `commit-via-api.ts --repo`) — and a
 * `--repo-dir` pointed at a checkout OF that repo: `git worktree list` runs
 * from the checkout you're standing in and only knows that repo's worktrees,
 * so an upstream-repo sweep from your own repo's checkout reports every
 * upstream worktree as a false stray and removes nothing (the dirs are
 * healthy, just tracked by a different checkout).
 * `--repo-dir` defaults to the current working directory — run this from your
 * repo checkout (same expectation as the worktree-creation flow in the feature
 * prompt), since `git worktree list`/`prune`/`remove` need a real git working
 * directory, not just the worktrees-root container. `--worktrees-root`
 * overrides the default `/tmp/worktrees` (mainly for tests). `--dry-run`
 * prints every decision without removing anything.
 *
 * On success it prints a one-line summary per worktree to stdout and exits 0;
 * a per-worktree failure (e.g. `git worktree remove` itself failing) is
 * reported in the summary rather than aborting the whole sweep. All
 * diagnostics unrelated to a specific worktree (e.g. a missing token) go to
 * stderr with a non-zero exit.
 */

import { Effect } from "effect";

import type {
  GhAppError,
  InstallationToken,
} from "@ori-monorepo/working-with-github/gh-app-token.ts";

import { mintInstallationToken } from "@ori-monorepo/working-with-github/gh-app-token-mint.ts";

import type { WorktreeOutcome } from "./cleanup-worktrees-core.ts";

import { cleanupWorktrees } from "./cleanup-worktrees-core.ts";
import { findSingleDashArgv, resolveRepoFromEnv } from "./commit-api-core.ts";

const DEFAULT_WORKTREES_ROOT = "/tmp/worktrees";

/** Output seam so a test can capture stdout/stderr without touching the process. */
export interface CleanupWriters {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export interface CleanupCliArgs {
  readonly repo: string;
  readonly repoDir: string;
  readonly worktreesRoot: string;
  readonly dryRun: boolean;
  /** Parse-time usage error: a single-dash argv token (`-repo`, the near-universal
   *  typo for `--repo`). A silent ignore retargeted a DESTRUCTIVE sweep at the
   *  default repo (GITHUB_REPO), removing ITS worktrees while the caller asked for
   *  another repo — the same never-silently-derive-a-default contract the
   *  `missingFlagValue` guard below exists to enforce. */
  readonly junkArgv?: string;
  /** Parse-time usage error: a value-taking flag was passed with no usable
   *  value (e.g. `--repo --dry-run`). Carried so the CLI entrypoint can fail
   *  loudly instead of silently sweeping a wrong default — the same shape
   *  `mint-token.ts` (`missingRepoValue`) and `commit-via-api.ts`
   *  (`parseFlagPair`) both reject. */
  readonly missingFlagValue?: string;
}

/** Parse `--repo`, `--repo-dir`, `--worktrees-root`, and `--dry-run` out of argv. */
export const parseCleanupArgs = (
  argv: readonly string[],
  // oxlint-disable-next-line node/no-process-env -- default deps seam; callers pass a fake env in tests.
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd()
): CleanupCliArgs => {
  const junkArgv = findSingleDashArgv(argv);
  const readFlag = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1 || i + 1 >= argv.length) {
      return undefined;
    }
    // Trim BEFORE the flag-shape check: a value that is a flag modulo
    // surrounding whitespace (`--repo " --dry-run "`) is the same unusable
    // shape, but checking the raw token first let it trim to "--dry-run" and
    // flow on as a real repo — sweeping a repo named after the flag while
    // the real flag was silently consumed as its value. An empty/
    // whitespace-only value is unusable the same way (`undefined`), so the
    // missingFlagValue marker below fires for an explicit `--repo ""` too
    // (an empty value silently fell through to GITHUB_REPO before,
    // misdiagnosed as "GITHUB_REPO is unset" when it was set — the same
    // class as #98/#107 in mint-token.ts).
    const value = argv[i + 1];
    const trimmed = value === undefined ? "" : value.trim();
    return trimmed.startsWith("--") || trimmed === ""
      ? undefined
      : trimmed;
    // The value is returned TRIMMED, matching `mint-token.ts`'s `read` and
    // `register-gh-app.ts`'s `readFlag`: a padded path (`--worktrees-root
    // " /tmp/w "`) otherwise goes through raw, `realpath` falls back to the
    // padded string on ENOENT, `readdir` swallows the error, and the sweep
    // exits 0 with "nothing under the worktrees root" — a silent no-op.
  };
  // A value-taking flag PRESENT but with no usable value (its slot eaten by
  // the next flag, or trailing at the end of argv) is a usage error, not a
  // silent default: `--repo --dry-run` would otherwise sweep the
  // GITHUB_REPO slug (or cwd-run git) as if the caller had asked for it.
  const missingFlagValue = ["--repo", "--repo-dir", "--worktrees-root"].find(
    (flag) => argv.includes(flag) && readFlag(flag) === undefined
  );
  // `--repo` tolerates the same spellings `GITHUB_REPO` does (a full https
  // URL with optional .git, or a bare owner/repo) — the same normalization
  // `commit-via-api.ts` applies to its `--repo`. A raw URL passed straight
  // through 404s every PR lookup, so the sweep reports each worktree as an
  // error and removes nothing; routing the flag through the env resolver
  // keeps both spellings on one path.
  const repo = resolveRepoFromEnv({
    ...env,
    GITHUB_REPO: readFlag("--repo") ?? env.GITHUB_REPO,
  });
  return {
    dryRun: argv.includes("--dry-run"),
    ...(junkArgv === undefined ? {} : { junkArgv }),
    ...(missingFlagValue === undefined ? {} : { missingFlagValue }),
    repo,
    repoDir: readFlag("--repo-dir") ?? cwd,
    worktreesRoot: readFlag("--worktrees-root") ?? DEFAULT_WORKTREES_ROOT,
  };
};

/** One-line, log-friendly summary of a single worktree outcome. */
export const formatOutcome = (outcome: WorktreeOutcome): string =>
  `[${outcome.decision}] ${outcome.path} — ${outcome.detail}`;

/**
 * The CLI core as an Effect: mint a token, sweep, write one summary line per
 * outcome to stdout. Resolves to the intended process exit code — never
 * throws. `mint` is injected so a test drives it with a fake.
 */
export const runCleanup = Effect.fn("CleanupWorktreesCli.runCleanup")(
  function* (
    mint: Effect.Effect<InstallationToken, GhAppError> | undefined,
    args: CleanupCliArgs,
    writers: CleanupWriters,
    // Ambient mode (GH_APP_ID unset): no App token can be minted, and the
    // host's egress proxy attaches the workspace credential to the bare PR
    // lookup instead — the same ambient REST discipline the feature prompt
    // teaches and gh-auth-health implements. The mint is skipped entirely;
    // an unauthorized bare lookup still surfaces as an error outcome.
    // Defaults to App mode (mint) for backwards compatibility with the tests
    // that inject a fake mint.
    ambient = false
  ) {
    if (args.missingFlagValue !== undefined) {
      // A parse-time usage error: the caller passed a value-taking flag with
      // no usable value (`--repo --dry-run`). Fail loudly — never sweep a
      // silently-derived default (GITHUB_REPO / cwd / /tmp/worktrees).
      writers.err(
        `cleanup-worktrees: ${args.missingFlagValue} needs a value (e.g. ${
          args.missingFlagValue === "--repo" ? "owner/repo" : "/a/path"
        })\n`
      );
      return 1;
    }
    if (args.junkArgv !== undefined) {
      // A single-dash token (`-repo o/r`) is a typo no CLI accepts: fail loudly
      // rather than silently sweeping the default repo's slug directory.
      writers.err(
        `cleanup-worktrees: unrecognized argument "${args.junkArgv}" — flags start with "--" (e.g. --repo owner/repo)\n`
      );
      return 1;
    }
    if (args.repo === "") {
      writers.err(
        "cleanup-worktrees: no --repo given and GITHUB_REPO is unset.\n"
      );
      return 1;
    }
    const token = ambient
      ? undefined
      : yield* (mint as Effect.Effect<InstallationToken, GhAppError>).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              writers.err(
                `cleanup-worktrees: could not mint a token: ${error.message}\n`
              );
            })
          )
        );
    if (!ambient && token === undefined) {
      return 1;
    }
    const summary = yield* cleanupWorktrees(
      // Ambient mode (no minted token): the lookup goes bare — see the
      // CleanupDeps.token doc in cleanup-worktrees-core.ts.
      { ...(token === undefined ? {} : { token: token.token }) },
      {
        dryRun: args.dryRun,
        repo: args.repo,
        // Scoped to this repo's own slug directory: a sibling slug belongs to
        // another repo, and this sweep's PR lookup cannot speak for it.
        repoSlug: args.repo.replaceAll("/", "-"),
        repoDir: args.repoDir,
        worktreesRoot: args.worktreesRoot,
      }
    );
    if (summary.outcomes.length === 0) {
      writers.out("cleanup-worktrees: nothing under the worktrees root.\n");
      return 0;
    }
    for (const outcome of summary.outcomes) {
      writers.out(`${formatOutcome(outcome)}\n`);
    }
    return summary.gitListFailed === true ||
      summary.outcomes.some((outcome) => outcome.decision === "error")
      ? 1
      : 0;
  }
);

// Only run the CLI when invoked directly (not when imported by a test).
if (import.meta.main) {
  const args = parseCleanupArgs(process.argv.slice(2));
  // oxlint-disable-next-line node/no-process-env -- GH_APP_ID is service config.
  const ambient = (process.env.GH_APP_ID ?? "") === "";
  const code = await Effect.runPromise(
    runCleanup(
      // In ambient mode the mint cannot succeed (no App credentials exist);
      // the runCleanup call above skips it, and this Effect is never forced.
      ambient ? undefined : mintInstallationToken({ targetRepo: args.repo }),
      args,
      {
        err: (text) => {
          process.stderr.write(text);
        },
        out: (text) => {
          process.stdout.write(text);
        },
      },
      ambient
    )
  );
  process.exit(code);
}
