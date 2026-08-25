/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * upload.ts — sending files and images into a thread.
 *
 * `files.upload` was retired on 2025-11-12. The replacement is a three-call
 * sequence, which is exactly what a caller assembles wrong, so the builtin
 * owns it:
 *
 *   1. `files.getUploadURLExternal` — reserve an upload URL and a file id.
 *   2. POST the bytes to that URL (plain HTTP, not a Web API method).
 *   3. `files.completeUploadExternal` — share it into a channel/thread.
 *
 * Neither Slack method is on `SlackClientShape`, so this goes through `raw`.
 * That is the intended use of the escape hatch: it still carries the
 * configured retry policy and timeout.
 */

import { Effect, Schema } from "effect";

import type { SlackClientShape } from "../../client/client.ts";

import { SlackApiError, SlackClient } from "../../client/client.ts";

/** A file to send. `content` is any `BlobPart`: string, Blob, or byte view. */
export interface FileUpload {
  readonly filename: string;
  readonly content: BlobPart;
  /** Shown as the file's title. Defaults to `filename`. */
  readonly title?: string | undefined;
}

export interface UploadedFile {
  readonly fileId: string;
  readonly permalink: string | undefined;
}

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
/** Generous enough for a large artifact on a slow link, short of forever. */
const UPLOAD_TIMEOUT_MS = 2 * SECONDS_PER_MINUTE * MS_PER_SECOND;

const apiError = (op: string, cause: unknown): SlackApiError =>
  new SlackApiError({
    cause,
    code: "unknown",
    op,
  });

/** Ask Slack where to put the bytes, and for the id to complete against. */
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
  // Slack reserves by byte length up front, so the content is materialised
  // here — the external upload API has no streaming path.
  const blob = new Blob([input.file.content]);

  const reserved = yield* reserveUpload(slack, input.file.filename, blob.size);

  // The configured retry and timeout policy lives on the WebClient, and this
  // leg does not go through it — it is a raw POST to a Slack-supplied URL. A
  // stalled connection here would otherwise hang the turn holding the thread.
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
