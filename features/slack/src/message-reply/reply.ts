import type { Effect } from "effect";

import { Schema } from "effect";

import type { PostedMessage, SlackApiError } from "#src/client/index.ts";
import type { SlackBlock } from "#src/helpers/block-kit/blocks.ts";
import type {
  FileUpload,
  UploadedFile,
} from "#src/helpers/images-files/upload.ts";

import { functionSchema } from "#src/schema-support.ts";
import { ThreadRefSchema } from "#src/thread/thread.ts";

const MessageReplyShapeSchema = Schema.Struct({
  ref: ThreadRefSchema,

  reply:
    functionSchema<
      (text: string) => Effect.Effect<PostedMessage, SlackApiError>
    >("MessageReplyShape.reply"),

  update:
    functionSchema<
      (ts: string, text: string) => Effect.Effect<void, SlackApiError>
    >("MessageReplyShape.update"),

  replyBlocks:
    functionSchema<
      (
        blocks: readonly SlackBlock[],
        fallback: string
      ) => Effect.Effect<PostedMessage, SlackApiError>
    >("MessageReplyShape.replyBlocks"),

  remove:
    functionSchema<(ts: string) => Effect.Effect<void, SlackApiError>>(
      "MessageReplyShape.remove"
    ),

  updateBlocks:
    functionSchema<
      (
        ts: string,
        blocks: readonly SlackBlock[],
        fallback: string
      ) => Effect.Effect<void, SlackApiError>
    >("MessageReplyShape.updateBlocks"),

  attach:
    functionSchema<
      (
        file: FileUpload,
        comment?: string
      ) => Effect.Effect<UploadedFile, SlackApiError>
    >("MessageReplyShape.attach"),
});

export type MessageReplyShape = typeof MessageReplyShapeSchema.Type;
