import { Result, Schema } from "effect";

import type { KnownBlock } from "@slack/types";

import { opaqueSchema } from "#src/schema-support.ts";
import {
  makeClient,
  markdownToSlack,
} from "#skills/slack-api/scripts/helpers.ts";
import { tryCatchAsync } from "#skills/slack-api/scripts/result.ts";

const UpdateMessageOptsSchema = Schema.Struct({
  channel: Schema.mutableKey(Schema.String),
  ts: Schema.mutableKey(Schema.String),
  text: Schema.mutableKey(Schema.String),
  blocks: Schema.mutableKey(
    Schema.optionalKey(
      Schema.UndefinedOr(
        Schema.Array(opaqueSchema<KnownBlock>("UpdateMessageOpts.blocks"))
      )
    )
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

type UpdateMessageOpts = typeof UpdateMessageOptsSchema.Type;

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