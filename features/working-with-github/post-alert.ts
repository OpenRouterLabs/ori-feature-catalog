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
 * Post a single top-level (non-threaded) message to a channel. Rejects when
 * `SLACK_BOT_TOKEN` is unset or the Slack API responds with a non-ok result,
 * so callers can decide whether to retry.
 */
export const postAlert = async (input: PostAlertInput): Promise<void> => {
  // oxlint-disable-next-line node/no-process-env -- SLACK_BOT_TOKEN is systemd-injected service config, read once at the call site.
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error("SLACK_BOT_TOKEN is not set");
  }
  // oxlint-disable unicorn/require-post-message-target-origin -- Slack WebClient.chat.postMessage, not window.postMessage; targetOrigin does not apply
  const result = await new WebClient(token, {
    retryConfig: RETRY_CONFIG,
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
