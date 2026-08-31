/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */

import type { Effect } from "effect";

import type { PostedMessage, SlackApiError } from "../client/index.ts";
import type { SlackBlock } from "../helpers/block-kit/blocks.ts";
import type {
  FileUpload,
  UploadedFile,
} from "../helpers/images-files/upload.ts";
import type { ThreadRef } from "../thread/thread.ts";

export interface MessageReplyShape {
  readonly ref: ThreadRef;

  readonly reply: (text: string) => Effect.Effect<PostedMessage, SlackApiError>;

  readonly update: (
    ts: string,
    text: string
  ) => Effect.Effect<void, SlackApiError>;

  readonly replyBlocks: (
    blocks: readonly SlackBlock[],
    fallback: string
  ) => Effect.Effect<PostedMessage, SlackApiError>;

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
