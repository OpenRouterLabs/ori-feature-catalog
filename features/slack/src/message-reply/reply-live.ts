import { Effect } from "effect";

import { type PostedMessage, type SlackApiError, SlackClient } from "#src/client/client.ts";
import { type SlackBlock, capBlocks, withinSlackLimit } from "#src/helpers/block-kit/blocks.ts";
import { type FileUpload, type UploadedFile, uploadFile } from "#src/helpers/images-files/upload.ts";
import type { ThreadRef } from "#src/thread/index.ts";
import type { MessageReplyShape } from "./reply.ts";


export const makeMessageReply = Effect.fn("Slack.reply.make")(function* (
  ref: ThreadRef
): Effect.fn.Return<MessageReplyShape, never, SlackClient> {
  const slack = yield* SlackClient;

  return {
    attach: (
      file: FileUpload,
      comment?: string
    ): Effect.Effect<UploadedFile, SlackApiError> =>
      uploadFile({
        channel: ref.channelId,
        file,
        initialComment: comment,
        threadTs: ref.threadTs,
      }).pipe(
        Effect.provideService(SlackClient, slack),
        Effect.withSpan("Slack.reply.attach")
      ),

    ref,

    reply: (text: string): Effect.Effect<PostedMessage, SlackApiError> =>
      slack
        .postMessage({
          channel: ref.channelId,
          markdown_text: withinSlackLimit(text),
          thread_ts: ref.threadTs,
        })
        .pipe(Effect.withSpan("Slack.reply.reply")),

    replyBlocks: (
      blocks: readonly SlackBlock[],
      fallback: string
    ): Effect.Effect<PostedMessage, SlackApiError> =>
      slack
        .postMessage({
          blocks: [...capBlocks(blocks)],
          channel: ref.channelId,
          text: withinSlackLimit(fallback),
          thread_ts: ref.threadTs,
        })
        .pipe(Effect.withSpan("Slack.reply.replyBlocks")),

    update: (ts: string, text: string): Effect.Effect<void, SlackApiError> =>
      slack
        .updateMessage({
          channel: ref.channelId,
          markdown_text: withinSlackLimit(text),
          ts,
        })
        .pipe(Effect.withSpan("Slack.reply.update")),

    remove: (ts: string): Effect.Effect<void, SlackApiError> =>
      slack
        .deleteMessage({
          channel: ref.channelId,
          ts,
        })
        .pipe(Effect.withSpan("Slack.reply.remove")),

    updateBlocks: (
      ts: string,
      blocks: readonly SlackBlock[],
      fallback: string
    ): Effect.Effect<void, SlackApiError> =>
      slack
        .updateMessage({
          blocks: [...capBlocks(blocks)],
          channel: ref.channelId,
          text: withinSlackLimit(fallback),
          ts,
        })
        .pipe(Effect.withSpan("Slack.reply.updateBlocks")),
  };
});
