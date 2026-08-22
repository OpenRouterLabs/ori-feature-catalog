/**
 * get-replies.ts — conversations.replies
 *
 * Fetch all messages in a thread, up to a total cap, via cursor pagination.
 * Returns `{ messages, hasMore }` — `hasMore` is true when the cap was reached
 * and Slack still had more pages, so callers can detect silent truncation.
 *
 * Usage:
 *   bun features/slack/skills/slack-api/scripts/slack.ts conversations.replies \
 *     --channel C123 --ts TS [--limit 50]
 *
 * NOTE: non-Marketplace Slack apps may be capped at 15 messages/request and
 * 1 req/min, so large threads can require several sequential requests.
 */

import { Result } from "effect";

import { makeClient } from "./helpers.ts";
import { tryCatchAsync } from "./result.ts";

const DEFAULT_LIMIT = 50;
const PER_PAGE_MAX = 200;

export interface GetRepliesOpts {
  channel: string;
  ts: string;
  limit?: number | undefined;
  /** Env map for SLACK_* configuration; defaults to Bun.env. */
  env?: Record<string, string | undefined> | undefined;
}

/** Fetch thread replies up to `opts.limit` total messages. */
export const getThreadReplies = async (
  opts: GetRepliesOpts
): Promise<Result.Result<unknown, Error>> => {
  const clientResult = makeClient(opts.env);
  if (Result.isFailure(clientResult)) {
    return Result.fail(clientResult.failure);
  }
  return await tryCatchAsync(async () => {
    const messages: unknown[] = [];
    const maxMessages = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
    let cursor: string | undefined;
    let hasMore = false;
    do {
      const page = await clientResult.success.conversations.replies({
        channel: opts.channel,
        ts: opts.ts,
        inclusive: true,
        limit: Math.min(maxMessages - messages.length, PER_PAGE_MAX),
        ...(cursor
          ? {
              cursor,
            }
          : {}),
      });
      const pageMessages = page.messages ?? [];
      messages.push(...pageMessages.slice(0, maxMessages - messages.length));
      const nextCursor = page.response_metadata?.next_cursor;
      if (messages.length < maxMessages) {
        cursor = nextCursor ?? undefined;
      } else {
        hasMore = Boolean(nextCursor);
        cursor = undefined;
      }
    } while (cursor);
    return {
      messages,
      hasMore,
    };
  });
};
