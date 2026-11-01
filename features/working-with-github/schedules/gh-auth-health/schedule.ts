/**
 * schedule.ts — the gh-auth-health schedule.
 *
 * Registers under the name `gh-auth-health` (nested schedule of the
 * `working-with-github` feature). Every 30 minutes the runtime fires it, in
 * whichever access mode the workspace runs:
 *
 * - **App mode** (`GH_APP_ID` set): verifies the host-rotated `GH_TOKEN`
 *   actually reaches the intern's repo. It never mints: the host rotates the
 *   token on a cadence, and minting on every fire counted against GitHub's
 *   rate limits.
 * - **Ambient mode** (`GH_APP_ID` unset): probes `GET /repos/{GITHUB_REPO}`
 *   (bare `GET https://api.github.com/` when GITHUB_REPO resolves to no repo)
 *   with no Authorization header — an owner-scoped request is the one a host's
 *   egress proxy attaches the workspace credential to; the unscoped root goes
 *   out anonymously. A reachable API is healthy (including the
 *   401/403/404 of a host that attaches no credential — that is the honest
 *   answer there, not a breakage); only unreachability or a 5xx alerts.
 *
 * On success it logs and stays silent; on failure it posts a :rotating_light:
 * alert (when an alert channel is configured) so a broken access path is caught
 * before it blocks real `git`/`gh` work.
 *
 * This is the honest mapping of "keep GitHub access working" onto the two
 * access models: in App mode its job is to continuously prove the rotated
 * token still reaches the repo; in ambient mode there is no credential at all,
 * so its job is to prove the API is reachable.
 */

import { Data, Effect } from "effect";
import { defineSchedule } from "ori";

import { isRepoUnset, resolveRepoFromEnv } from "@ori-monorepo/working-with-github/commit-api-core.ts";
import { resolveGitHubToken } from "@ori-monorepo/working-with-github/gh-app-token-mint.ts";
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
        // credential when there is one. Probe the intern's own repo when
        // GITHUB_REPO resolves: the proxy credentials owner-scoped routes, and
        // the unscoped root alone reads the anonymous bucket.
        if (appId === "") {
          // oxlint-disable-next-line node/no-process-env -- GITHUB_REPO is systemd-injected service config.
          yield* ambientGitHubReachable({ repo: resolveRepoFromEnv(process.env) }).pipe(
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

        // App mode: token + repo round-trip.
        // oxlint-disable-next-line node/no-process-env -- GITHUB_REPO is systemd-injected service config.
        const repo = resolveRepoFromEnv(process.env);
        if (repo === "") {
          // The two causes of an empty repo need different guidance: genuinely
          // unset (the operator must configure it) vs SET to a spelling that
          // resolves to no owner/repo — e.g. the orgs-page INDEX URL
          // `https://github.com/orgs` (#203), which names no owner at all.
          // Pre-fix both printed "not set", a lie for the set case that sent
          // the operator to inspect service env that was present and populated.
          // oxlint-disable-next-line node/no-process-env -- GITHUB_REPO is systemd-injected service config.
          return yield* Effect.die(
            new Error(
              isRepoUnset(process.env)
                ? "gh-auth-health: GITHUB_REPO is not set — cannot run the auth round-trip check."
                : `gh-auth-health: GITHUB_REPO "${(process.env.GITHUB_REPO ?? "").trim()}" resolves to no owner/repo — cannot run the auth round-trip check. Check its spelling (e.g. github.com/orgs, the organizations index, names no owner).`
            )
          );
        }

        yield* ghAuthHealthCheck({
          mint: resolveGitHubToken(),
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
