import { Effect, Schema } from "effect";

import type { RawSlackMessage } from "#src/surface/listeners.ts";

import { functionSchema } from "#src/schema-support.ts";

import {
  attachmentDirFor,
  discardAttachments,
  downloadAttachments,
} from "./attachment-download.ts";
import {
  attachedFiles,
  downloadableFiles,
  untrustedFilesWarning,
  withDownloadedPaths,
} from "./untrusted-files.ts";

const TurnAttachmentsSchema = Schema.Struct({
  dir: Schema.String,
  fetched: Schema.Number,
  warning: Schema.UndefinedOr(Schema.String),
});

type TurnAttachments = typeof TurnAttachmentsSchema.Type;

const TurnAttachmentDepsSchema = Schema.Struct({
  fetch: functionSchema<typeof globalThis.fetch>("TurnAttachmentDeps.fetch"),
  token: Schema.String,
});

export type TurnAttachmentDeps = typeof TurnAttachmentDepsSchema.Type;

const gatherAttachments = Effect.fn("Slack.attachments.gather")(function* (
  event: RawSlackMessage,
  deps: TurnAttachmentDeps
): Effect.fn.Return<TurnAttachments> {
  const threadTs = event.thread_ts ?? event.ts ?? "";
  const dir = attachmentDirFor(threadTs);
  const files = attachedFiles(event);
  const fetched = yield* downloadAttachments(downloadableFiles(files), {
    fetch: deps.fetch,
    token: deps.token,
    writeDir: dir,
  });

  return {
    dir,
    fetched: fetched.length,
    warning: untrustedFilesWarning(withDownloadedPaths(files, fetched)),
  };
});

export const makeTurnAttachments =
  (deps: TurnAttachmentDeps) =>
  Effect.fn("Slack.attachments.run")(function* <E, R>(
    event: RawSlackMessage,
    run: (warning: string | undefined) => Effect.Effect<void, E, R>
  ): Effect.fn.Return<void, E, R> {
    const gathered = yield* gatherAttachments(event, deps);

    yield* run(gathered.warning).pipe(
      Effect.ensuring(
        gathered.fetched > 0
          ? Effect.forkDetach(discardAttachments(gathered.dir))
          : Effect.void
      )
    );
  });
