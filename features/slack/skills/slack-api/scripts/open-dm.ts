import type { WebClient } from "@slack/web-api";

import { Result, Schema } from "effect";

import { opaqueSchema } from "#src/schema-support.ts";
import { makeClient } from "./helpers.ts";
import { tryCatchAsync } from "./result.ts";

const OpenDmOptsSchema = Schema.Struct({
  users: Schema.mutableKey(Schema.String),
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
      Schema.UndefinedOr(opaqueSchema<WebClient>("OpenDmOpts.client"))
    )
  ),
});

type OpenDmOpts = typeof OpenDmOptsSchema.Type;

export const openDm = async (
  opts: OpenDmOpts
): Promise<Result.Result<unknown, Error>> => {
  const clientResult = opts.client
    ? Result.succeed(opts.client)
    : makeClient(opts.env);
  if (Result.isFailure(clientResult)) {
    return Result.fail(clientResult.failure);
  }
  return await tryCatchAsync(() =>
    clientResult.success.conversations.open({
      users: opts.users,
    })
  );
};