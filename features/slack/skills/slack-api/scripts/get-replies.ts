import type { WebClient } from "@slack/web-api";

import { Result, Schema } from "effect";

import { opaqueSchema } from "#src/schema-support.ts";
import { makeClient } from "./helpers.ts";
import { tryCatchAsync } from "./result.ts";

const DEFAULT_LIMIT = 50;
const PER_PAGE_MAX = 200;

const GetRepliesOptsSchema = Schema.Struct({
  channel: Schema.mutableKey(Schema.String),
  ts: Schema.mutableKey(Schema.String),
  limit: Schema.mutableKey(
    Schema.optionalKey(Schema.UndefinedOr(Schema.Number))
  ),
  env: Schema.mutableKey(
    Schema.optionalKey(
      Schema.UndefinedOr(
        Schema.Record(
          Schema.String,
          Schema.mutableKey(Schema.UndefinedOr(Schema.String))
        )
      )
    )
  ),
  client: Schema.mutableKey(
    Schema.optionalKey(
      Schema.UndefinedOr(opaqueSchema<WebClient>("GetRepliesOpts.client"))
    )
  ),
});

export type GetRepliesOpts = typeof GetRepliesOptsSchema.Type;

export const getThreadReplies = async (
  opts: GetRepliesOpts
): Promise<Result.Result<unknown, Error>> => {
  const clientResult: Result.Result<WebClient, Error> = opts.client
    ? Result.succeed(opts.client)
    : makeClient(opts.env);
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