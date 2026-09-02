import { type Option, Result, Schema } from "effect";


import type { KnownBlock } from "@slack/types";

import { opaqueSchema } from "#src/schema-support.ts";
import {
  makeClient,
  markdownToSlack,
  resolveThreadTs,
} from "#skills/slack-api/scripts/helpers.ts";
import { tryCatchAsync } from "#skills/slack-api/scripts/result.ts";

const PostMessageOptsSchema = Schema.Struct({
  channel: Schema.mutableKey(Schema.String),
  text: Schema.mutableKey(
    Schema.optionalKey(Schema.UndefinedOr(Schema.String))
  ),
  blocks: Schema.mutableKey(
    Schema.optionalKey(
      Schema.UndefinedOr(
        Schema.Array(opaqueSchema<KnownBlock>("PostMessageOpts.blocks"))
      )
    )
  ),
  threadTs: Schema.mutableKey(
    Schema.optionalKey(Schema.UndefinedOr(Schema.String))
  ),
  noThread: Schema.mutableKey(
    Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean))
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
});

type PostMessageOpts = typeof PostMessageOptsSchema.Type;

export const PostMessageResponse = Schema.Struct({
  ts: Schema.NonEmptyString,
});

export type PostMessageResponse = typeof PostMessageResponse.Type;

export const decodePostMessageResponse =
  Schema.decodeUnknownOption(PostMessageResponse);

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