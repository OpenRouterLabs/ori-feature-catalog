/**
 * post-alert.ts — outbound Slack posting for the gh-auth-health schedule.
 *
 * The built-in `slack` chat surface drives interactive turns; it exposes no
 * public posting API to project features. Scheduled features that need to *push*
 * a top-level message post directly via `@slack/web-api` using the bot token.
 */

import { WebClient } from "@slack/web-api";

export interface PostAlertInput {
  /** Channel id to post into. */
  readonly channel: string;
  /** Plain-text / mrkdwn message body. */
  readonly text: string;
}

/**
 * Transient-error resilience (exponential backoff, 200ms base, factor 2, up to
 * 3 retries) via the SDK's built-in `retryConfig`. This only covers network /
 * HTTP-level failures inside `WebClient#makeRequest` (timeouts, 5xx, rate
 * limits) — a non-ok platform result (`result.ok === false`, e.g.
 * `invalid_auth`) surfaces after that retry loop and is never retried.
 */
const RETRY_CONFIG = {
  retries: 3,
  minTimeout: 200,
  factor: 2,
};

/**
 * How long one HTTP attempt of the alert post may wait for `slack.com` before
 * the SDK's axios layer aborts it. The vendored `@slack/web-api` (7.15.0)
 * defaults `timeout` to 0 — NO timeout — and hands it straight to axios, so a
 * client built with only `retryConfig` (the pre-fix shape) leaves a wedged
 * `chat.postMessage` pending forever: a dropped route or wedged proxy to
 * slack.com never settles the promise, the `Effect.catch` that swallows an
 * alert failure (see the alert-escape contract in
 * schedules/gh-auth-health/alert-escape.test.ts) never runs — it only fires
 * on a SETTLED failure — and the fire stays pending forever, so the runtime
 * skips every later fire and the schedule whose whole job is to surface
 * broken GitHub access goes silent in exactly the state it exists to catch.
 *
 * The same wedge class is why both sibling network paths of this schedule
 * bound their waits (`AMBIENT_PROBE_TIMEOUT_MS`, `ROUND_TRIP_TIMEOUT_MS` in
 * gh-auth-health.ts); the alert post is the fire's third network call and the
 * one that runs precisely when GitHub is broken. The bound must cover the
 * retry ladder the SDK walks INSIDE one call (200+400+800ms of delays, ~1.4s)
 * so a transient Slack 5xx still gets its retries before the deadline.
 */
export const POST_ALERT_TIMEOUT_MS = 15_000;

/**
 * Post a single top-level (non-threaded) message to a channel. Rejects when
 * `SLACK_BOT_TOKEN` is unset or the Slack API responds with a non-ok result,
 * so callers can decide whether to retry.
 */
export const postAlert = async (
  input: PostAlertInput,
  options: {
    /** Overrides for tests — never set in production. */
    readonly slackApiUrl?: string | undefined;
  } = {}
): Promise<void> => {
  // oxlint-disable-next-line node/no-process-env -- SLACK_BOT_TOKEN is systemd-injected service config, read once at the call site.
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error("SLACK_BOT_TOKEN is not set");
  }
  // oxlint-disable unicorn/require-post-message-target-origin -- Slack WebClient.chat.postMessage, not window.postMessage; targetOrigin does not apply
  const result = await new WebClient(token, {
    retryConfig: RETRY_CONFIG,
    // The request deadline — see POST_ALERT_TIMEOUT_MS. Without it the SDK's
    // `timeout = 0` default leaves a wedged post pending forever.
    timeout: POST_ALERT_TIMEOUT_MS,
    ...(options.slackApiUrl === undefined
      ? {}
      : { slackApiUrl: options.slackApiUrl }),
  }).chat.postMessage({
    channel: input.channel,
    text: input.text,
    unfurl_links: false,
    unfurl_media: false,
  });
  // oxlint-enable unicorn/require-post-message-target-origin
  if (!result.ok) {
    throw new Error(
      `Slack chat.postMessage failed: ${result.error ?? "unknown error"}`
    );
  }
};
