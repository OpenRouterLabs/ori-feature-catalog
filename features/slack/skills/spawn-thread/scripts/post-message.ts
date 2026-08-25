/**
 * post-message.ts — chat.postMessage
 *
 * Usage:
 *   bun features/slack/skills/slack-api/scripts/slack.ts chat.postMessage \
 *     --channel C123 --text "hello" [--thread-ts TS] [--no-thread] [--blocks '[...]']
 *
 * Thread routing:
 *   - Same-channel posts: auto-use $SLACK_THREAD_TS when --thread-ts is omitted.
 *   - Cross-channel posts (when an env channel is known): require --thread-ts or --no-thread.
 *   - --no-thread: post a top-level (unthreaded) message.
 *
 * --text is rendered through slackify-markdown to Slack mrkdwn. Pass --blocks
 * '[...]' to supply your own Block Kit payload; --text is then used as the
 * notification/accessibility fallback.
 */
/**
 * NOT a general capability. This is spawn-thread's own posting, moved out of
 * the slack-api skill when that became read-only: opening a fresh top-level
 * thread is the one write the daemon has no route for, and it exists for this
 * purpose rather than as something the agent reaches for to talk.
 *
 * Everything the agent says goes through the daemon — the slack-status skill for
 * updates, the surface itself for the answer — so that rationing, the
 * markdown-block formatting and the one-answer-per-turn rule are not optional.
 */

import { Option, Result, Schema } from "effect";

import type { KnownBlock } from "@slack/types";

import {
  makeClient,
  markdownToSlack,
  resolveThreadTs,
} from "#skills/slack-api/scripts/helpers.ts";
import { tryCatchAsync } from "./guards.ts";

export interface PostMessageOpts {
  channel: string;
  text?: string | undefined;
  blocks?: readonly KnownBlock[] | undefined;
  threadTs?: string | undefined;
  /** Set true to post a top-level (unthreaded) message; also bypasses the cross-channel guard. */
  noThread?: boolean | undefined;
  /** Env map for SLACK_* configuration; defaults to Bun.env. */
  env?: Record<string, string | undefined> | undefined;
}

// chat.postMessage answers with far more than this, but `ts` is the only field
// spawn-thread reads and the decode is what keeps that contract honest at the
// boundary rather than at each call site. Slack can answer ok:true with no ts,
// which the pre-existing contract treats as "no thread id" — hence the Option
// rather than a decode failure. Excess fields are stripped by default.
export const PostMessageResponse = Schema.Struct({
  ts: Schema.NonEmptyString,
});

export type PostMessageResponse = typeof PostMessageResponse.Type;

/** Exported so a caller can decode a response it obtained some other way. */
export const decodePostMessageResponse =
  Schema.decodeUnknownOption(PostMessageResponse);

/** Post a Slack message. `None` means Slack returned no usable `ts`. */
export const postMessage = async (
  opts: PostMessageOpts
): Promise<Result.Result<Option.Option<PostMessageResponse>, Error>> => {
  const clientResult = makeClient(opts.env);
  if (Result.isFailure(clientResult)) {
    return Result.fail(clientResult.failure);
  }
  const threadTsResult = resolveThreadTs(opts.channel, {
    threadTs: opts.threadTs,
    noThread: opts.noThread,
    guardCrossChannel: true,
    env: opts.env,
  });
  if (Result.isFailure(threadTsResult)) {
    return Result.fail(threadTsResult.failure);
  }
  const effectiveThreadTs = threadTsResult.success;
  const postText = opts.text ? markdownToSlack(opts.text) : "";
  const sent = await tryCatchAsync(() =>
    clientResult.success.chat.postMessage({
      channel: opts.channel,
      text: postText,
      ...(effectiveThreadTs
        ? {
            thread_ts: effectiveThreadTs,
          }
        : {}),
      ...(opts.blocks
        ? {
            blocks: opts.blocks,
          }
        : {}),
    })
  );
  return Result.map(sent, decodePostMessageResponse);
};
