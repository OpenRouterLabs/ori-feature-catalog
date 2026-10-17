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

/** The fire's logic as an Effect — a single `Effect.runPromise` at the `run`
 *  boundary below drives it (the SDK's `run` handler returns a Promise). */
const sweepWorktrees = Effect.fn("WorktreeCleanupSchedule.sweep")(function* (
  logger: FeatureLogger
) {
  // oxlint-disable-next-line node/no-process-env -- GH_APP_ID is service config.
  if ((process.env.GH_APP_ID ?? "") === "") {
    logger.info("worktree-cleanup: GH_APP_ID is not set; no worktrees to sweep.");
    return;
  }
  const repo = resolveRepoFromEnv();
  if (repo === "") {
    return yield* Effect.die(
      new Error(
        "worktree-cleanup: GITHUB_REPO is not set — cannot resolve which slug to sweep."
      )
    );
  }
  const token = yield* mintInstallationToken({ targetRepo: repo }).pipe(
    Effect.catch((error) =>
      Effect.die(
        new Error(`worktree-cleanup: could not mint a token: ${error.message}`)
      )
    )
  );
  const summary = yield* cleanupWorktrees(
    { token: token.token },
    // `ori start` runs from the repo checkout by convention (same as `ori
    // dev`), so `process.cwd()` here is a real git working directory.
    {
      dryRun: false,
      repo,
      repoDir: process.cwd(),
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
