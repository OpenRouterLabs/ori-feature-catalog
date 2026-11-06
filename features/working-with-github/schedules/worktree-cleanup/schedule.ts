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

import { resolveRepoDir } from "./repo-dir.ts";

import { cleanupWorktrees } from "../../scripts/cleanup-worktrees-core.ts";
import { formatOutcome } from "../../scripts/cleanup-worktrees.ts";
import {
  isRepoUnset,
  resolveRepoFromEnv,
} from "../../scripts/commit-api-core.ts";
import { resolveGitHubToken } from "../../gh-app-token-mint.ts";
import { redactUserinfo } from "../../gh-app-registry.ts";

const WORKTREES_ROOT = "/tmp/worktrees";


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
  // oxlint-disable-next-line node/no-process-env -- GITHUB_REPO is systemd-injected service config.
  if (repo === "" && ambient && isRepoUnset(process.env)) {
    // Ambient mode does not require GITHUB_REPO (gh-auth-health probes the
    // root without one), and the change flow that makes worktrees under
    // /tmp/worktrees/<slug>/ keys them by that repo. With no repo there is
    // no slug to sweep, so finish quietly. Pre-fix this died, and every
    // daily fire on such a host was recorded as an error.
    logger.info(
      "worktree-cleanup: GITHUB_REPO is not set in ambient mode — no repo slug to sweep."
    );
    return;
  }
  if (repo === "") {
    // The two causes of an empty repo need different guidance: genuinely
    // unset (the operator must configure it) vs SET to a spelling that
    // resolves to no owner/repo — e.g. the orgs-page INDEX URL
    // `https://github.com/orgs` (#203), which names no owner at all. Pre-fix
    // both printed "not set", a lie for the set case.
    // oxlint-disable-next-line node/no-process-env -- GITHUB_REPO is systemd-injected service config.
    return yield* Effect.die(
      new Error(
        isRepoUnset(process.env)
          ? "worktree-cleanup: GITHUB_REPO is not set — cannot resolve which slug to sweep."
          : `worktree-cleanup: GITHUB_REPO "${redactUserinfo((process.env.GITHUB_REPO ?? "").trim())}" resolves to no owner/repo — cannot resolve which slug to sweep. Check its spelling (e.g. github.com/orgs, the organizations index, names no owner).`
      )
    );
  }
  const token = ambient
    ? undefined
    : yield* resolveGitHubToken({ targetRepo: repo }).pipe(
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
