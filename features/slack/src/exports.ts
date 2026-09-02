import { Effect } from "effect";

import type { Block, KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";

import type { SlackClientShape } from "./client/index.ts";

import { makeSlackClientFromToken } from "./client/index.ts";
import { readBotToken } from "./config.ts";
import { capBlocks, withinSlackLimit } from "./helpers/block-kit/blocks.ts";

export interface SlackPostMessageInput {
  readonly channel: string;
  readonly text: string;
  readonly threadTs?: string;
  readonly blocks?: readonly (Block | KnownBlock)[];
  readonly unfurlLinks?: boolean;
  readonly unfurlMedia?: boolean;
}

export type SlackPostMessageResult =
  | { readonly ok: true; readonly channel: string; readonly ts?: string }
  | { readonly ok: false; readonly error: string };

let client: SlackClientShape | undefined;

const resolveClient = (): SlackClientShape | undefined => {
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

export { actions, button } from "./helpers/block-kit/blocks.ts";
