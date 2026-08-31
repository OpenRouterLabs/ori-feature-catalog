#!/usr/bin/env bun

import { retryPolicies, WebClient } from "@slack/web-api";
import { slackifyMarkdown } from "slackify-markdown";

import { recordLiveLine } from "#src/turn/live-line.ts";
import { postStatus } from "./post-status.ts";

const REQUEST_TIMEOUT_MS = 30_000;

const localApiUrl = (raw: string | undefined): string | undefined => {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const host = URL.parse(raw)?.hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]"
    ? raw
    : undefined;
};

const asMrkdwn = (text: string): string =>
  slackifyMarkdown(
    text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
  ).trim();

if (import.meta.main) {
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
