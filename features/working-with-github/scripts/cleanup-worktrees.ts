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
 * explicit `--repo owner/repo` (mirroring `commit-via-api.ts --repo`).
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
import { resolveRepoFromEnv } from "./commit-api-core.ts";

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
}

/** Parse `--repo`, `--repo-dir`, `--worktrees-root`, and `--dry-run` out of argv. */
export const parseCleanupArgs = (
  argv: readonly string[],
  // oxlint-disable-next-line node/no-process-env -- default deps seam; callers pass a fake env in tests.
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd()
): CleanupCliArgs => {
  const read = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1 || i + 1 >= argv.length) {
      return undefined;
    }
    const value = argv[i + 1];
    return value === undefined || value.startsWith("--") ? undefined : value;
  };
  return {
    dryRun: argv.includes("--dry-run"),
    repo: read("--repo") ?? resolveRepoFromEnv(env),
    repoDir: read("--repo-dir") ?? cwd,
    worktreesRoot: read("--worktrees-root") ?? DEFAULT_WORKTREES_ROOT,
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
    mint: Effect.Effect<InstallationToken, GhAppError>,
    args: CleanupCliArgs,
    writers: CleanupWriters
  ) {
    if (args.repo === "") {
      writers.err(
        "cleanup-worktrees: no --repo given and GITHUB_REPO is unset.\n"
      );
      return 1;
    }
    const token = yield* mint.pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          writers.err(
            `cleanup-worktrees: could not mint a token: ${error.message}\n`
          );
        })
      )
    );
    if (token === undefined) {
      return 1;
    }
    const summary = yield* cleanupWorktrees(
      { token: token.token },
      {
        dryRun: args.dryRun,
        repo: args.repo,
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
    return summary.outcomes.some((outcome) => outcome.decision === "error")
      ? 1
      : 0;
  }
);

// Only run the CLI when invoked directly (not when imported by a test).
if (import.meta.main) {
  const args = parseCleanupArgs(process.argv.slice(2));
  const code = await Effect.runPromise(
    runCleanup(mintInstallationToken({ targetRepo: args.repo }), args, {
      err: (text) => {
        process.stderr.write(text);
      },
      out: (text) => {
        process.stdout.write(text);
      },
    })
  );
  process.exit(code);
}
