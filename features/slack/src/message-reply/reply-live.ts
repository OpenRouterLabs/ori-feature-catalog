/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * reply-live.ts — a reply surface bound to one thread.
 *
 * Markdown is passed through as-is: Slack renders it natively via
 * `markdown_text`, so there is no conversion layer to keep in sync.
 *
 * `markdown_text` is mutually exclusive with `text`/`blocks` — Slack rejects
 * the call outright with `markdown_text_conflict` if both are present
 * (https://docs.slack.dev/reference/methods/chat.postMessage). `reply`/`update`
 * therefore send `markdown_text` alone; `replyBlocks`/`updateBlocks` send
 * `blocks` with a plain-text `fallback` in `text`, never `markdown_text`.
 *
 * Length is enforced HERE, at the boundary that actually talks to Slack, so no
 * caller can bypass it. Slack rejects an over-long message outright rather
 * than trimming it, which would turn a long agent answer into no answer at
 * all — the worst possible outcome for the user who asked.
 */

import { Effect } from "effect";

import type { PostedMessage, SlackApiError } from "../client/client.ts";
import type { SlackBlock } from "../helpers/block-kit/blocks.ts";
import type {
  FileUpload,
  UploadedFile,
} from "../helpers/images-files/upload.ts";
import type { ThreadRef } from "../thread/thread.ts";
import type { MessageReplyShape } from "./reply.ts";

import { SlackClient } from "../client/client.ts";
import { capBlocks, withinSlackLimit } from "../helpers/block-kit/blocks.ts";
import { uploadFile } from "../helpers/images-files/upload.ts";

/** Liveness without a message, bound to the thread like the rest. */
export const makeMessageReply = (
  ref: ThreadRef
): Effect.Effect<MessageReplyShape, never, SlackClient> =>
  Effect.gen(function* () {
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
        }).pipe(Effect.provideService(SlackClient, slack)),

      ref,

      reply: (text: string): Effect.Effect<PostedMessage, SlackApiError> =>
        slack.postMessage({
          channel: ref.channelId,
          markdown_text: withinSlackLimit(text),
          thread_ts: ref.threadTs,
        }),

      replyBlocks: (
        blocks: readonly SlackBlock[],
        fallback: string
      ): Effect.Effect<PostedMessage, SlackApiError> =>
        slack.postMessage({
          blocks: [...capBlocks(blocks)],
          channel: ref.channelId,
          text: withinSlackLimit(fallback),
          thread_ts: ref.threadTs,
        }),

      update: (ts: string, text: string): Effect.Effect<void, SlackApiError> =>
        slack.updateMessage({
          channel: ref.channelId,
          markdown_text: withinSlackLimit(text),
          ts,
        }),

      remove: (ts: string): Effect.Effect<void, SlackApiError> =>
        slack.deleteMessage({
          channel: ref.channelId,
          ts,
        }),

      updateBlocks: (
        ts: string,
        blocks: readonly SlackBlock[],
        fallback: string
      ): Effect.Effect<void, SlackApiError> =>
        slack.updateMessage({
          blocks: [...capBlocks(blocks)],
          channel: ref.channelId,
          text: withinSlackLimit(fallback),
          ts,
        }),
    };
  });
