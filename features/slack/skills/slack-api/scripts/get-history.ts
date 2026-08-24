/**
 * get-history.ts — conversations.history
 *
 * Fetch messages from a channel's history with cursor pagination, dedup by `ts`,
 * and a time-window guard. Returns `{ messages, hasMore }`.
 *
 * Usage:
 *   bun features/slack/skills/slack-api/scripts/slack.ts conversations.history \
 *     --channel C123 [--oldest 1234567890.000000] [--latest 1234567890.999999] [--limit 1000]
 *
 * Flags:
 *   --channel  Channel ID (required, or via $SLACK_CHANNEL_ID).
 *   --oldest   Unix seconds; inclusive lower bound.
 *   --latest   Unix seconds; inclusive upper bound.
 *   --limit    Max total messages. Default 1000. Pass 0 for "unlimited" (10k cap).
 *
 * NOTE: Slack cursors do NOT encode the oldest/latest window — both flags are
 * re-sent on every paginated request so page 2+ stays inside the requested window.
 */

import type { WebClient } from "@slack/web-api";

import { Result } from "effect";

import { makeClient } from "./helpers.ts";
import { isString, tryCatchAsync } from "./result.ts";

const DEFAULT_LIMIT = 1000;
const UNLIMITED_MODE_CAP = 10_000;
const PER_PAGE_MAX = 200;

export interface GetHistoryOpts {
  channel: string;
  oldest?: string | undefined;
  latest?: string | undefined;
  /** Max messages. Default 1000. Pass 0 for "unlimited" (capped at 10k). */
  limit?: number | undefined;
  /** Env map for SLACK_* configuration; defaults to Bun.env. */
  env?: Record<string, string | undefined> | undefined;
  /** Injected Slack client; defaults to one built from `env`. */
  client?: WebClient | undefined;
}

const tsOf = (msg: unknown): string | undefined => {
  if (typeof msg === "object" && msg !== null && "ts" in msg) {
    const { ts } = msg as {
      ts: unknown;
    };
    return isString(ts) ? ts : undefined;
  }
  return undefined;
};

// The oldest/latest window is re-sent on every page (Slack cursors do not
// encode it); the conditional spreads exist because the SDK's optional fields
// reject explicit undefined under exactOptionalPropertyTypes.
export const historyPageArgs = (input: {
  readonly opts: GetHistoryOpts;
  readonly cursor: string | undefined;
  readonly collected: number;
  readonly maxTotal: number;
}): Parameters<WebClient["conversations"]["history"]>[0] => ({
  channel: input.opts.channel,
  limit: Math.min(
    PER_PAGE_MAX,
    input.maxTotal > 0
      ? Math.max(1, input.maxTotal - input.collected)
      : PER_PAGE_MAX
  ),
  ...(input.opts.oldest || input.opts.latest
    ? {
        inclusive: true,
      }
    : {}),
  ...(input.cursor
    ? {
        cursor: input.cursor,
      }
    : {}),
  ...(input.opts.oldest
    ? {
        oldest: input.opts.oldest,
      }
    : {}),
  ...(input.opts.latest
    ? {
        latest: input.opts.latest,
      }
    : {}),
});

/** Append a page's messages, deduped by `ts`, into the running list. */
export const appendDedupedMessages = (
  seen: Set<string>,
  messages: unknown[],
  page: readonly unknown[]
): void => {
  for (const msg of page) {
    const ts = tsOf(msg);
    if (ts && !seen.has(ts)) {
      seen.add(ts);
      messages.push(msg);
    }
  }
};

/**
 * Whether pagination must stop after this page: `done` when an explicit limit
 * is satisfied, `capped` when unlimited mode (limit 0) hits its safety cap so
 * the caller reports hasMore, `continue` otherwise.
 */
export const capStateAfterPage = (
  maxTotal: number,
  collected: number
): "capped" | "continue" | "done" => {
  if (maxTotal > 0 && collected >= maxTotal) {
    return "done";
  }
  if (maxTotal === 0 && collected >= UNLIMITED_MODE_CAP) {
    return "capped";
  }
  return "continue";
};

/** Fetch channel history with pagination, dedup, and a time-window guard. */
export const fetchChannelHistory = async (
  opts: GetHistoryOpts
): Promise<Result.Result<unknown, Error>> => {
  const clientResult: Result.Result<WebClient, Error> = opts.client
    ? Result.succeed(opts.client)
    : makeClient(opts.env);
  if (Result.isFailure(clientResult)) {
    return Result.fail(clientResult.failure);
  }
  const maxTotal = opts.limit ?? DEFAULT_LIMIT;
  return await tryCatchAsync(async () => {
    const seen = new Set<string>();
    const messages: unknown[] = [];
    let cursor: string | undefined;
    // Assigned on every pass before the loop condition reads it; the do-while
    // guarantees at least one pass, so no initializer is needed.
    let capState: "capped" | "continue" | "done";
    do {
      const page = await clientResult.success.conversations.history(
        historyPageArgs({
          collected: messages.length,
          cursor,
          maxTotal,
          opts,
        })
      );
      appendDedupedMessages(seen, messages, page.messages ?? []);
      cursor = page.response_metadata?.next_cursor ?? undefined;
      capState = capStateAfterPage(maxTotal, messages.length);
    } while (cursor && capState === "continue");
    return {
      messages: maxTotal > 0 ? messages.slice(0, maxTotal) : messages,
      hasMore: capState === "capped" || Boolean(cursor),
    };
  });
};
