/**
 * schedule.ts — the gh-auth-health schedule.
 *
 * Registers under the name `gh-auth-health` (nested schedule of the
 * `working-with-github` feature). Every 30 minutes the runtime fires it, in
 * whichever access mode the workspace runs:
 *
 * - **App mode** (`GH_APP_ID` set): mints a fresh GitHub App installation token
 *   and verifies the token actually reaches the intern's repo.
 * - **Ambient mode** (`GH_APP_ID` unset): probes `GET https://api.github.com/`
 *   with no Authorization header — the request a host's egress proxy attaches
 *   the workspace credential to. A reachable API is healthy (including the
 *   401/403/404 of a host that attaches no credential — that is the honest
 *   answer there, not a breakage); only unreachability or a 5xx alerts.
 *
 * On success it logs and stays silent; on failure it posts a :rotating_light:
 * alert (when an alert channel is configured) so a broken access path is caught
 * before it blocks real `git`/`gh` work.
 *
 * This is the honest mapping of "keep GitHub access working" onto the two
 * access models: in App mode there is no token at rest to refresh, so the
 * schedule's job is to continuously prove the mint path is healthy; in ambient
 * mode there is no credential at all, so its job is to prove the API is
 * reachable. The token minted here is used only for the in-memory round-trip
 * check and is discarded when the handler returns — the same no-token-at-rest
 * guarantee as the ephemeral `GH_TOKEN` injection callers use for real
 * `git`/`gh` work.
 *
 * The handler runs in-process in the runtime (which holds GH_APP_PRIVATE_KEY in
 * its environment), so it can mint directly without spawning an agent.
 */

import { Data, Effect } from "effect";
import { defineSchedule } from "ori";

import { resolveRepoFromEnv } from "@ori-monorepo/working-with-github/commit-api-core.ts";
import { mintInstallationToken } from "@ori-monorepo/working-with-github/gh-app-token-mint.ts";
import { postAlert } from "@ori-monorepo/working-with-github/post-alert.ts";

import { readGhAuthHealthConfig } from "./config.ts";
import {
  ambientGitHubReachable,
  formatHealthErrorLog,
  formatHealthOkLog,
  ghAuthHealthCheck,
  renderHealthAlert,
} from "./gh-auth-health.ts";

/**
 * Tagged failure for the `postAlert` Slack call. Keeps the `Effect.tryPromise`
 * error channel typed (`AlertPostError`) instead of the opaque global `Error`
 * the language-service flags; it still `extends Error` (via `Data.TaggedError`)
 * and delegates its `message` to the original `cause`, so behaviour is unchanged.
 */
class AlertPostError extends Data.TaggedError("AlertPostError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error
      ? this.cause.message
      : String(this.cause);
  }
}

/** Success log for the ambient probe — mirrors `formatHealthOkLog`'s shape. */
const formatAmbientOkLog = (ok: { readonly scopes: string | undefined }) =>
  ok.scopes === undefined
    ? "gh-auth-health: ok — GitHub API reachable with no App configured (ambient access; no scopes echoed)."
    : `gh-auth-health: ok — GitHub API reachable with no App configured (ambient access; scopes: ${ok.scopes}).`;

/** Failure log for the ambient probe. */
const formatAmbientErrorLog = (detail: string) =>
  `gh-auth-health: FAILED ambient probe — ${detail}`;

/** Slack alert for the ambient probe. */
const renderAmbientAlert = (detail: string) =>
  [
    ":rotating_light: *GitHub ambient access check failed*",
    `Detail: ${detail}`,
    "",
    "GitHub is unreachable from this workspace with no GitHub App configured — ambient (proxy-attached) access is broken. Check the host's egress proxy / network path to api.github.com.",
  ].join("\n");

export const schedule = defineSchedule({
  // Every 30 minutes. Access either works or it doesn't — there is no token to
  // keep warm, so this cadence is purely how quickly a broken config is
  // surfaced. The runtime owns firing and skips a still-running fire.
  cron: "*/30 * * * *",
  // The handler is one Effect program, run once at this ori boundary (the SDK's
  // `run` returns a Promise, so `Effect.runPromise` lives here and only here).
  // The healthy/failed split is the Effect success/failure channel — no Result,
  // no `ok` flag: `matchEffect` branches the two channels.
  run: ({ logger }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const config = readGhAuthHealthConfig();
        // oxlint-disable-next-line node/no-process-env -- GH_APP_ID is service config.
        const appId = process.env.GH_APP_ID ?? "";

        // Ambient mode: probe the API the way the feature prompt teaches —
        // bare, no Authorization header; the host's proxy attaches the
        // credential when there is one. No repo is needed: there is nothing to
        // mint against.
        if (appId === "") {
          yield* ambientGitHubReachable({}).pipe(
            Effect.matchEffect({
              onSuccess: (ok) =>
                Effect.sync(() => {
                  logger.info(formatAmbientOkLog(ok));
                }),
              onFailure: (failure) =>
                Effect.gen(function* () {
                  logger.error(formatAmbientErrorLog(failure.detail), undefined, {
                    detail: failure.detail,
                  });
                  // No alert channel configured → the log line above is the only
                  // surface. Set GH_AUTH_HEALTH_ALERT_CHANNEL_ID to also page a
                  // Slack channel.
                  const { alertChannelId } = config;
                  if (alertChannelId === undefined) {
                    return;
                  }
                  // oxlint-disable-next-line node/no-process-env -- SLACK_BOT_TOKEN is systemd-injected service config.
                  if (!process.env.SLACK_BOT_TOKEN) {
                    return yield* Effect.die(
                      new Error(
                        `gh-auth-health: ambient probe failed (${failure.detail}) and SLACK_BOT_TOKEN is unset — cannot post the alert.`
                      )
                    );
                  }
                  yield* Effect.tryPromise({
                    try: () =>
                      postAlert({
                        channel: alertChannelId,
                        text: renderAmbientAlert(failure.detail),
                      }),
                    catch: (cause) => new AlertPostError({ cause }),
                  }).pipe(
                    // The health failure is already logged and recorded — a
                    // failing Slack post must not replace it. Pre-fix the
                    // typed AlertPostError escaped `matchEffect` and
                    // rejected the whole run, so the run history recorded
                    // the SLACK error instead of the GitHub failure this
                    // schedule exists to surface. Log and complete the fire.
                    Effect.catch((error) =>
                      Effect.sync(() => {
                        logger.error(
                          "gh-auth-health: could not post the Slack alert — the failure is recorded in this log line instead",
                          error,
                          { alertChannelId, detail: failure.detail }
                        );
                      })
                    )
                  );
                }),
            })
          );
          return;
        }

        // App mode: mint + repo round-trip.
        // oxlint-disable-next-line node/no-process-env -- GITHUB_REPO is systemd-injected service config.
        const repo = resolveRepoFromEnv(process.env);
        if (repo === "") {
          return yield* Effect.die(
            new Error(
              "gh-auth-health: GITHUB_REPO is not set — cannot run the auth round-trip check."
            )
          );
        }

        yield* ghAuthHealthCheck({
          mint: mintInstallationToken(),
          repo,
        }).pipe(
          Effect.matchEffect({
            onSuccess: (ok) =>
              Effect.sync(() => {
                logger.info(formatHealthOkLog(repo, ok), { ok: true });
              }),
            onFailure: (failure) =>
              Effect.gen(function* () {
                logger.error(formatHealthErrorLog(repo, failure), undefined, {
                  detail: failure.detail,
                  stage: failure.stage,
                });
                // No alert channel configured → the log line above is the only
                // surface. Set GH_AUTH_HEALTH_ALERT_CHANNEL_ID to also page a
                // Slack channel.
                const { alertChannelId } = config;
                if (alertChannelId === undefined) {
                  return;
                }
                // oxlint-disable-next-line node/no-process-env -- SLACK_BOT_TOKEN is systemd-injected service config.
                if (!process.env.SLACK_BOT_TOKEN) {
                  return yield* Effect.die(
                    new Error(
                      `gh-auth-health: check failed at ${failure.stage} (${failure.detail}) and SLACK_BOT_TOKEN is unset — cannot post the alert.`
                    )
                  );
                }
                yield* Effect.tryPromise({
                  try: () =>
                    postAlert({
                      channel: alertChannelId,
                      text: renderHealthAlert(repo, failure),
                    }),
                  catch: (cause) => new AlertPostError({ cause }),
                }).pipe(
                  // Same contract as the ambient branch: the health failure
                  // is already logged and recorded; a failing Slack post
                  // must not replace it in the run history or kill the fire.
                  Effect.catch((error) =>
                    Effect.sync(() => {
                      logger.error(
                        "gh-auth-health: could not post the Slack alert — the failure is recorded in this log line instead",
                        error,
                        {
                          alertChannelId,
                          detail: failure.detail,
                          stage: failure.stage,
                        }
                      );
                    })
                  )
                );
              }),
          })
        );
      })
    ),
});
