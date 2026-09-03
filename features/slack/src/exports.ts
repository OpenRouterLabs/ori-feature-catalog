import { Effect, Schema } from "effect";

import type { Block, KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";

import type { SlackClientShape } from "./client/client.ts";

import { makeSlackClientFromToken } from "./client/client-live.ts";
import { readBotToken } from "./config.ts";
import { featureState } from "./feature-state.ts";
import { capBlocks, withinSlackLimit } from "./helpers/block-kit/index.ts";
import { opaqueSchema } from "./schema-support.ts";

const SlackPostMessageInputSchema = Schema.Struct({
  channel: Schema.String,
  text: Schema.String,
  threadTs: Schema.optionalKey(Schema.String),
  blocks: Schema.optionalKey(
    Schema.Array(
      opaqueSchema<Block | KnownBlock>("SlackPostMessageInput.blocks")
    )
  ),
  unfurlLinks: Schema.optionalKey(Schema.Boolean),
  unfurlMedia: Schema.optionalKey(Schema.Boolean),
});

export type SlackPostMessageInput = typeof SlackPostMessageInputSchema.Type;

export type SlackPostMessageResult =
  | { readonly ok: true; readonly channel: string; readonly ts?: string }
  | { readonly ok: false; readonly error: string };

let client: SlackClientShape | undefined;

const resolveClient = (): SlackClientShape | undefined => {
  const running = featureState().runtime?.slack;
  if (running !== undefined) {
    return running;
  }
  if (client !== undefined) {
    return client;
  }
  const token = readBotToken();
  if (token === undefined) {
    return undefined;
  }
  client = makeSlackClientFromToken(token);
  return client;
};

export const webClient = (): WebClient | undefined => resolveClient()?.raw;

export const makePostMessage =
  (slack: SlackClientShape) =>
  (input: SlackPostMessageInput): Promise<SlackPostMessageResult> =>
    Effect.runPromise(
      Effect.tryPromise(() =>
        slack.raw.chat.postMessage({
          channel: input.channel,
          text: withinSlackLimit(input.text),
          unfurl_links: input.unfurlLinks ?? false,
          unfurl_media: input.unfurlMedia ?? false,
          ...(input.blocks === undefined
            ? {}
            : { blocks: [...capBlocks(input.blocks)] }),
          ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
        })
      ).pipe(
        Effect.match({
          onFailure: (error): SlackPostMessageResult => ({
            error:
              error.cause instanceof Error
                ? error.cause.message
                : String(error.cause),
            ok: false,
          }),
          onSuccess: (response): SlackPostMessageResult => ({
            channel: response.channel ?? input.channel,
            ok: true,
            ...(response.ts === undefined ? {} : { ts: response.ts }),
          }),
        })
      )
    );

export const postMessage = (
  input: SlackPostMessageInput
): Promise<SlackPostMessageResult> => {
  const slack = resolveClient();
  return slack === undefined
    ? Promise.resolve({
        error: "SLACK_BOT_TOKEN is not set",
        ok: false,
      })
    : makePostMessage(slack)(input);
};

export {
  onButton,
  RESERVED_ACTION_PREFIX,
  registeredButtonIds,
} from "./interactions/custom.ts";
export type {
  SlackButtonClick,
  SlackButtonHandler,
} from "./interactions/custom.ts";

export { actions, button } from "./helpers/block-kit/index.ts";
