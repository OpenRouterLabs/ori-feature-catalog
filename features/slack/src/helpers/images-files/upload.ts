import { Effect, Schema } from "effect";

import type { SlackClientShape } from "#src/client/index.ts";

import { SlackApiError, SlackClient } from "#src/client/index.ts";
import { opaqueSchema } from "#src/schema-support.ts";

const FileUploadSchema = Schema.Struct({
  content: opaqueSchema<BlobPart>("FileUpload.content"),
  filename: Schema.String,
  title: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
});

export type FileUpload = typeof FileUploadSchema.Type;

const UploadedFileSchema = Schema.Struct({
  fileId: Schema.String,
  permalink: Schema.UndefinedOr(Schema.String),
});

export type UploadedFile = typeof UploadedFileSchema.Type;

const UploadUrlResponse = Schema.Struct({
  file_id: Schema.String,
  upload_url: Schema.String,
});

const CompleteResponse = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      permalink: Schema.optionalKey(Schema.String),
    })
  ),
});

const decodeUploadUrl = Schema.decodeUnknownEffect(UploadUrlResponse);
const decodeComplete = Schema.decodeUnknownEffect(CompleteResponse);

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const UPLOAD_TIMEOUT_MS = 2 * SECONDS_PER_MINUTE * MS_PER_SECOND;

const apiError = (op: string, cause: unknown): SlackApiError =>
  new SlackApiError({
    cause,
    code: "unknown",
    op,
  });

const reserveUpload = (
  slack: SlackClientShape,
  filename: string,
  length: number
): Effect.Effect<{ file_id: string; upload_url: string }, SlackApiError> =>
  Effect.tryPromise({
    catch: (cause) => apiError("files.getUploadURLExternal", cause),
    try: () =>
      slack.raw.files.getUploadURLExternal({
        filename,
        length,
      }),
  }).pipe(
    Effect.flatMap((raw) => decodeUploadUrl(raw)),
    Effect.mapError((cause) => apiError("files.getUploadURLExternal", cause)),
    Effect.withSpan("Slack.imagesFiles.reserveUpload")
  );

export const uploadFile = Effect.fn("Slack.imagesFiles.upload")(function* (
  input: {
    readonly channel: string;
    readonly file: FileUpload;
    readonly initialComment?: string | undefined;
    readonly threadTs?: string | undefined;
  }
) {
  const slack = yield* SlackClient;
  const blob = new Blob([input.file.content]);

  const reserved = yield* reserveUpload(slack, input.file.filename, blob.size);

  yield* Effect.tryPromise({
    catch: (cause) => apiError("files.upload.post", cause),
    try: () =>
      fetch(reserved.upload_url, {
        body: blob,
        method: "POST",
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      }),
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.void
        : Effect.fail(
            apiError(
              "files.upload.post",
              new Error(`upload responded ${response.status}`)
            )
          )
    ),
    Effect.withSpan("Slack.imagesFiles.postBytes")
  );

  const completed = yield* Effect.tryPromise({
    catch: (cause) => apiError("files.completeUploadExternal", cause),
    try: () =>
      slack.raw.files.completeUploadExternal({
        channel_id: input.channel,
        files: [
          {
            id: reserved.file_id,
            title: input.file.title ?? input.file.filename,
          },
        ],
        ...(input.initialComment === undefined
          ? {}
          : { initial_comment: input.initialComment }),
        ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
      }),
  }).pipe(
    Effect.flatMap((raw) => decodeComplete(raw)),
    Effect.mapError((cause) => apiError("files.completeUploadExternal", cause)),
    Effect.withSpan("Slack.imagesFiles.completeUpload")
  );

  const first = completed.files.at(0);
  return {
    fileId: first?.id ?? reserved.file_id,
    permalink: first?.permalink,
  } satisfies UploadedFile;
});
