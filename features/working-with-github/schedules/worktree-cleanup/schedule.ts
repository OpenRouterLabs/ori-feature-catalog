/**
 * schedule.ts — the worktree-cleanup schedule.
 *
 * Registers under the name `worktree-cleanup` (nested schedule of the
 * `working-with-github` feature). Once daily, sweeps `/tmp/worktrees/<slug>/`
 * for the intern's own repo and removes any worktree whose branch has a
 * merged/closed PR and no uncommitted changes — the cleanup step the
 * worktree-first workflow's own last line (`git worktree remove`) misses
 * whenever a run crashes, gets killed, or a PR is merged/closed after the run
 * has moved on. See `cleanup-worktrees-core.ts` for the exact safety model.
 *
 * Routine maintenance, not an infra-health page like `gh-auth-health` — no
 * Slack alert on failure, just a log line. Only sweeps the intern's own repo;
 * an upstream composed-feature sweep needs an explicit CLI run with `--repo`.
 */

import type { FeatureLogger } from "ori";

import { Effect } from "effect";
import { defineSchedule } from "ori";

import { cleanupWorktrees } from "@ori-monorepo/working-with-github/cleanup-worktrees-core.ts";
import { formatOutcome } from "@ori-monorepo/working-with-github/cleanup-worktrees.ts";
import { resolveRepoFromEnv } from "@ori-monorepo/working-with-github/commit-api-core.ts";
import { mintInstallationToken } from "@ori-monorepo/working-with-github/gh-app-token-mint.ts";

const WORKTREES_ROOT = "/tmp/worktrees";

/**
 * Resolve the directory the sweep's `git` commands run from. The checkout the
 * daemon runs from is NOT reliably `process.cwd()` — in the standard intern
 * layout the daemon is started from `/workspace`, one level above the actual
 * git checkout, and `git worktree list`/`prune` there fail with "not a git
 * repository", killing every daily sweep. Prefer the runtime's explicit
 * `ORI_INTERN_WORKSPACE_ROOT` (the workspace checkout); fall back to the old
 * `process.cwd()` only when it is unset.
 */
export const resolveRepoDir = (): string =>
  (process.env.ORI_INTERN_WORKSPACE_ROOT ?? "").trim() !== ""
    ? (process.env.ORI_INTERN_WORKSPACE_ROOT ?? "").trim()
    : process.cwd();

/** The fire's logic as an Effect — a single `Effect.runPromise` at the `run`
 *  boundary below drives it (the SDK's `run` handler returns a Promise). */
const sweepWorktrees = Effect.fn("WorktreeCleanupSchedule.sweep")(function* (
  logger: FeatureLogger
) {
  // oxlint-disable-next-line node/no-process-env -- GH_APP_ID is service config.
  // Ambient mode (GH_APP_ID unset): no App token can be minted, and the host's
  // egress proxy attaches the workspace credential to the bare PR lookup
  // itself — the same ambient REST discipline gh-auth-health implements. The
  // sweep runs without a token (an unauthorized lookup surfaces as an error
  // outcome, never a silent skip) instead of falsely claiming there is
  // nothing to sweep.
  const ambient = (process.env.GH_APP_ID ?? "") === "";
  const repo = resolveRepoFromEnv();
  if (repo === "") {
    return yield* Effect.die(
      new Error(
        "worktree-cleanup: GITHUB_REPO is not set — cannot resolve which slug to sweep."
      )
    );
  }
  const token = ambient
    ? undefined
    : yield* mintInstallationToken({ targetRepo: repo }).pipe(
        Effect.catch((error) =>
          Effect.die(
            new Error(
              `worktree-cleanup: could not mint a token: ${error.message}`
            )
          )
        )
      );
  const repoDir = resolveRepoDir();
  const summary = yield* cleanupWorktrees(
    // Ambient mode: no token — the lookup goes bare (see CleanupDeps.token).
    { ...(token === undefined ? {} : { token: token.token }) },
    {
      dryRun: false,
      repo,
      // Scoped to this repo's own slug directory (`SLUG=${GITHUB_REPO//\//-}`),
      // matching the CLI: a sibling slug belongs to another repo, and this
      // sweep's PR lookup against `repo` cannot speak for it.
      repoSlug: repo.replaceAll("/", "-"),
      repoDir,
      worktreesRoot: WORKTREES_ROOT,
    }
  );
  if (summary.outcomes.length === 0) {
    logger.info("worktree-cleanup: nothing under the worktrees root.");
    return;
  }
  for (const outcome of summary.outcomes) {
    const line = formatOutcome(outcome);
    if (outcome.decision === "error") {
      logger.error(line);
    } else {
      logger.info(line);
    }
  }
});

export const schedule = defineSchedule({
  // Once daily. Worktrees accumulate slowly (one per self-modification task),
  // so there is no benefit to a tighter cadence — this just keeps them from
  // piling up indefinitely.
  cron: "0 5 * * *",
  run: ({ logger }) => Effect.runPromise(sweepWorktrees(logger)),
});
