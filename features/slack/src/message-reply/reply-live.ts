import { Effect } from "effect";

import type {
  PostedMessage,
  SlackApiError,
  SlackClientShape,
} from "#src/client/client.ts";
import type { SlackBlock } from "#src/helpers/block-kit/blocks.ts";
import type {
  FileUpload,
  UploadedFile,
} from "#src/helpers/images-files/upload.ts";
import type { ThreadRef } from "#src/thread/thread.ts";

import { SlackClient } from "#src/client/client.ts";
import { capBlocks, withinSlackLimit } from "#src/helpers/block-kit/blocks.ts";
import { uploadFile } from "#src/helpers/images-files/upload.ts";

export const attachFile =
  (slack: SlackClientShape, ref: ThreadRef) =>
  (
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
    );

export const replyText =
  (slack: SlackClientShape, ref: ThreadRef) =>
  (text: string): Effect.Effect<PostedMessage, SlackApiError> =>
    slack
      .postMessage({
        channel: ref.channelId,
        markdown_text: withinSlackLimit(text),
        thread_ts: ref.threadTs,
      })
      .pipe(Effect.withSpan("Slack.reply.reply"));

export const replyBlocks =
  (slack: SlackClientShape, ref: ThreadRef) =>
  (
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
      .pipe(Effect.withSpan("Slack.reply.replyBlocks"));

export const updateText =
  (slack: SlackClientShape, ref: ThreadRef) =>
  (ts: string, text: string): Effect.Effect<void, SlackApiError> =>
    slack
      .updateMessage({
        channel: ref.channelId,
        markdown_text: withinSlackLimit(text),
        ts,
      })
      .pipe(Effect.withSpan("Slack.reply.update"));

export const removeMessage =
  (slack: SlackClientShape, ref: ThreadRef) =>
  (ts: string): Effect.Effect<void, SlackApiError> =>
    slack
      .deleteMessage({
        channel: ref.channelId,
        ts,
      })
      .pipe(Effect.withSpan("Slack.reply.remove"));

export const updateBlocks =
  (slack: SlackClientShape, ref: ThreadRef) =>
  (
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
      .pipe(Effect.withSpan("Slack.reply.updateBlocks"));
