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
  limit?: number | undefined;
  env?: Record<string, string | undefined> | undefined;
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
