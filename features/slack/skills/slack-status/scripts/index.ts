#!/usr/bin/env bun

/**
 * index.ts — the `slack-status` CLI entry.
 *
 * The skill and the daemon's beat share one definition of where the live line
 * is kept; two copies of that path is how they drift. The `#src/*` subpath
 * comes from this feature's own package.json `imports` map, so the reach into
 * `src/` reads as one absolute name rather than a count of `../` hops.
 */

import { retryPolicies, WebClient } from "@slack/web-api";
import { slackifyMarkdown } from "slackify-markdown";

import { recordLiveLine } from "#src/turn/indicator/index.ts";
import { postStatus } from "./post-status.ts";

/** Long enough for a slow Slack, short enough that a turn notices. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * A base URL override is honoured only for loopback, so a stray environment
 * cannot redirect a call carrying the bot token at an arbitrary host. It
 * exists so the probe can point a real agent at a Slack that records.
 */
const localApiUrl = (raw: string | undefined): string | undefined => {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const host = URL.parse(raw)?.hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]"
    ? raw
    : undefined;
};

/**
 * Slack renders a message as mrkdwn, not the GFM the model is taught to write
 * everywhere else, so `**bold**` and `[label](url)` arrive literally unless
 * they are converted. The same conversion lives at `helpers/block-kit/mrkdwn.ts`
 * for the block paths; this copy exists because a skill runs as its own
 * process and does not import the surface.
 *
 * The escape comes FIRST and is not about formatting: `<!channel>` in a body
 * broadcasts to the workspace, and this is model-authored text that can quote
 * a message the run just read. `slackify-markdown` passes those through.
 */
const asMrkdwn = (text: string): string =>
  slackifyMarkdown(
    text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
  ).trim();

if (import.meta.main) {
  // Flags LEAD, and parsing stops at the first word: a filter over the whole
  // list ate the word from "Explaining why --notify exists".
  const args = process.argv.slice(2);
  let cursor = 0;
  let notify = false;
  while (args[cursor] === "--notify") {
    notify = true;
    cursor += 1;
  }
  const text = args.slice(cursor).join(" ");

  const token = Bun.env.SLACK_BOT_TOKEN;
  if (token === undefined || token === "") {
    process.stderr.write("slack-status: SLACK_BOT_TOKEN is not set\n");
    process.exit(1);
  }

  const apiUrl = localApiUrl(Bun.env.SLACK_API_URL);
  // `new WebClient(token)` inherits a ~30 minute retry ladder and no timeout,
  // so a 429 sleeps inside the SDK and surfaces nothing. `client-live.ts`
  // wrote that down for the daemon.
  const slack = new WebClient(token, {
    retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
    timeout: REQUEST_TIMEOUT_MS,
    ...(apiUrl === undefined ? {} : { slackApiUrl: apiUrl }),
  });

  const threadKey = `slack:${Bun.env.SLACK_TEAM_ID ?? ""}:${Bun.env.SLACK_CHANNEL_ID ?? ""}:${Bun.env.SLACK_THREAD_TS ?? ""}`;

  const outcome = await postStatus({
    env: Bun.env,
    notify,
    postMessage: async ({ pane, text: body }) => {
      await slack.chat.postMessage({
        channel: pane.channelId,
        text: asMrkdwn(body),
        thread_ts: pane.threadTs,
        // A URL would otherwise drag a preview card into the thread, which
        // makes an aside the biggest thing in it.
        unfurl_links: false,
        unfurl_media: false,
      });
    },
    setLine: async ({ pane, text: line }) => {
      await slack.assistant.threads.setStatus({
        channel_id: pane.channelId,
        status: line,
        thread_ts: pane.threadTs,
      });
      // Where the daemon's beat can find it: Slack drops the indicator on
      // every message the app posts, and the beat is the only thing running
      // for the whole turn to put it back.
      await recordLiveLine(threadKey, line);
    },
    text,
  });

  if (outcome.kind === "error") {
    process.stderr.write(`slack-status: ${outcome.message}\n`);
    process.exit(1);
  }
  process.stdout.write(
    outcome.notified
      ? `posted to the thread and set: ${outcome.text}\n`
      : `set: ${outcome.text}\n`
  );
  process.exit(0);
}
