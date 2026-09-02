import type { Effect } from "effect";

import type { PostedMessage, SlackApiError } from "#src/client/index.ts";
import type { SlackBlock } from "#src/helpers/block-kit/blocks.ts";
import type {
  FileUpload,
  UploadedFile,
} from "#src/helpers/images-files/upload.ts";
import type { ThreadRef } from "#src/thread/thread.ts";

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
