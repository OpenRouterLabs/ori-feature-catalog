/**
 * schedule.ts — the gh-auth-health schedule.
 *
 * Registers under the name `gh-auth-health` (nested schedule of the
 * `working-with-github` feature). Every 30 minutes the runtime fires it: it
 * mints a fresh GitHub App installation token and verifies the token actually
 * reaches the intern's repo. On success it logs and stays silent; on failure it
 * posts a :rotating_light: alert (when an alert channel is configured) so a
 * broken auth path is caught before it blocks real `git`/`gh` work.
 *
 * This is the honest mapping of "keep gh auth working" onto the mint-on-demand
 * model: there is no token at rest to refresh, so the schedule's job is to
 * continuously prove the mint path is healthy. The token minted here is used
 * only for the in-memory round-trip check and is discarded when the handler
 * returns — the same no-token-at-rest guarantee as the ephemeral `GH_TOKEN`
 * injection callers use for real `git`/`gh` work.
 *
 * The handler runs in-process in the runtime (which holds GH_APP_PRIVATE_KEY in
 * its environment), so it can mint directly without spawning an agent.
 */

import { Data, Effect } from "effect";
import { defineSchedule } from "ori";

import { mintInstallationToken } from "@ori-monorepo/working-with-github/gh-app-token-mint.ts";
import { postAlert } from "@ori-monorepo/working-with-github/post-alert.ts";

import { readGhAuthHealthConfig } from "./config.ts";
import {
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

/** Resolve `owner/repo` from `GITHUB_REPO`, tolerating a full https URL. */
const resolveRepo = (
  env: Readonly<Record<string, string | undefined>>
): string => {
  const raw = (env.GITHUB_REPO ?? "").trim();
  const withoutSuffix = raw.replace(/\.git$/u, "");
  const match = /github\.com[/:]([^/]+\/[^/]+)$/u.exec(withoutSuffix);
  if (match?.[1] !== undefined) {
    return match[1];
  }
  return withoutSuffix;
};

export const schedule = defineSchedule({
  // Every 30 minutes. Auth either works or it doesn't — there is no token to
  // keep warm, so this cadence is purely how quickly a broken App config is
  // surfaced. The runtime owns firing and skips a still-running fire.
  cron: "*/30 * * * *",
  // The handler is one Effect program, run once at this ori boundary (the SDK's
  // `run` returns a Promise, so `Effect.runPromise` lives here and only here).
  // The healthy/failed split is the Effect success/failure channel — no Result,
  // no `ok` flag: `matchEffect` branches the two channels.
  run: ({ logger }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        // oxlint-disable-next-line node/no-process-env -- GH_APP_ID is service config.
        if ((process.env.GH_APP_ID ?? "") === "") {
          logger.info("gh-auth-health: GH_APP_ID is not set; no GitHub App to check.");
          return;
        }
        const config = readGhAuthHealthConfig();
        // oxlint-disable-next-line node/no-process-env -- GITHUB_REPO is systemd-injected service config.
        const repo = resolveRepo(process.env);
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
                });
              }),
          })
        );
      })
    ),
});
