/**
 * update-message.ts — chat.update
 *
 * Usage:
 *   bun features/slack/skills/slack-api/scripts/slack.ts chat.update \
 *     --channel C123 --ts TS --text "updated" [--blocks '[...]']
 *
 * When --blocks is provided the message is updated with the given Block Kit
 * payload; --text is still required as the notification/accessibility fallback.
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

import { Result } from "effect";

import type { KnownBlock } from "@slack/types";

import {
  makeClient,
  markdownToSlack,
} from "#skills/slack-api/scripts/helpers.ts";
import { tryCatchAsync } from "#skills/slack-api/scripts/result.ts";

export interface UpdateMessageOpts {
  channel: string;
  ts: string;
  text: string;
  blocks?: readonly KnownBlock[] | undefined;
  /** Env map for SLACK_* configuration; defaults to Bun.env. */
  env?: Record<string, string | undefined> | undefined;
}

/** Update an existing Slack message. Returns the Slack API response. */
export const updateMessage = async (
  opts: UpdateMessageOpts
): Promise<Result.Result<unknown, Error>> => {
  const clientResult = makeClient(opts.env);
  if (Result.isFailure(clientResult)) {
    return Result.fail(clientResult.failure);
  }
  return await tryCatchAsync(() =>
    clientResult.success.chat.update({
      channel: opts.channel,
      ts: opts.ts,
      text: markdownToSlack(opts.text),
      ...(opts.blocks
        ? {
            blocks: opts.blocks,
          }
        : {}),
    })
  );
};
