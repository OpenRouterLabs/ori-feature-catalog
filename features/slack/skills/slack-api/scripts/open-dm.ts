import type { WebClient } from "@slack/web-api";

import { Result } from "effect";

import { makeClient } from "./helpers.ts";
import { tryCatchAsync } from "./result.ts";

interface OpenDmOpts {
  users: string;
  env?: Record<string, string | undefined> | undefined;
  client?: WebClient | undefined;
}

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
