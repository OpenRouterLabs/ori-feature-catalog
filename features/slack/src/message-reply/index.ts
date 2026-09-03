import { Effect } from "effect";

import type { ThreadRef } from "#src/thread/thread.ts";
import type { MessageReplyShape } from "./reply.ts";

import { SlackClient } from "#src/client/client.ts";
import {
  attachFile,
  removeMessage,
  replyBlocks,
  replyText,
  updateBlocks,
  updateText,
} from "./reply-live.ts";

export const makeMessageReply = Effect.fn("Slack.reply.make")(function* (
  ref: ThreadRef
): Effect.fn.Return<MessageReplyShape, never, SlackClient> {
  const slack = yield* SlackClient;

  return {
    attach: attachFile(slack, ref),
    ref,
    reply: replyText(slack, ref),
    replyBlocks: replyBlocks(slack, ref),
    remove: removeMessage(slack, ref),
    update: updateText(slack, ref),
    updateBlocks: updateBlocks(slack, ref),
  };
});
