import { Result } from "effect";

import type { KnownBlock } from "@slack/types";

import {
  makeClient,
  markdownToSlack,
} from "#skills/slack-api/scripts/helpers.ts";
import { tryCatchAsync } from "#skills/slack-api/scripts/result.ts";

interface UpdateMessageOpts {
  channel: string;
  ts: string;
  text: string;
  blocks?: readonly KnownBlock[] | undefined;
  env?: Record<string, string | undefined> | undefined;
}

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
