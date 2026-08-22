/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * reply.ts — the thread-bound reply port.
 *
 * Base-level per the RFC, not a helper: the thread is bound once so callers
 * never re-thread `channel`/`thread_ts` through every call. Everything that
 * answers a user goes through here, which is what lets `message-stream` own
 * pacing without each call site knowing about the update budget.
 */

import type { Effect } from "effect";

import type { PostedMessage, SlackApiError } from "../client/client.ts";
import type { SlackBlock } from "../helpers/block-kit/blocks.ts";
import type {
  FileUpload,
  UploadedFile,
} from "../helpers/images-files/upload.ts";
import type { ThreadRef } from "../thread/thread.ts";

export interface MessageReplyShape {
  /** The thread this surface answers into. */
  readonly ref: ThreadRef;

  readonly reply: (text: string) => Effect.Effect<PostedMessage, SlackApiError>;

  readonly update: (
    ts: string,
    text: string
  ) => Effect.Effect<void, SlackApiError>;

  /** Post Block Kit into the thread. `fallback` is the notification text. */
  readonly replyBlocks: (
    blocks: readonly SlackBlock[],
    fallback: string
  ) => Effect.Effect<PostedMessage, SlackApiError>;

  /** Rewrite a Block Kit message — used to retire buttons once answered. */
  /** Remove a message this surface posted. */
  readonly remove: (ts: string) => Effect.Effect<void, SlackApiError>;

  readonly updateBlocks: (
    ts: string,
    blocks: readonly SlackBlock[],
    fallback: string
  ) => Effect.Effect<void, SlackApiError>;

  readonly attach: (
    file: FileUpload,
    comment?: string
  ) => Effect.Effect<UploadedFile, SlackApiError>;
}
