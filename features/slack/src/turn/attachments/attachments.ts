import { Effect, Schema } from "effect";

import { RawSlackMessageSchema } from "#src/surface/listeners.ts";

import {
  attachmentDirFor,
  discardAttachments,
  downloadAttachments,
} from "./attachment-download.ts";
import { attachedFiles, untrustedFilesWarning } from "./untrusted-files.ts";

const TurnAttachmentsSchema = Schema.Struct({
  dir: Schema.String,
  fetched: Schema.Number,
  warning: Schema.UndefinedOr(Schema.String),
});

type TurnAttachments = typeof TurnAttachmentsSchema.Type;

const IncomingEventSchema = Schema.Struct({
  event: RawSlackMessageSchema,
  token: Schema.String,
});

type IncomingEvent = typeof IncomingEventSchema.Type;

const gatherAttachments = Effect.fn("Slack.attachments.gather")(function* (
  input: IncomingEvent
): Effect.fn.Return<TurnAttachments> {
  const threadTs = input.event.thread_ts ?? input.event.ts ?? "";
  const dir = attachmentDirFor(threadTs);
  const files = attachedFiles(input.event);
  const fetched = yield* downloadAttachments(
    files.filter((file) => file.urlPrivate !== "" && file.id !== ""),
    {
      fetch: globalThis.fetch,
      token: input.token,
      writeDir: dir,
    }
  );
  const pathById = new Map(fetched.map((file) => [file.id, file.path]));

  return {
    dir,
    fetched: fetched.length,
    warning: untrustedFilesWarning(
      files.map((file) => ({
        ...file,
        path: pathById.get(file.id),
      }))
    ),
  };
});

export const withAttachments = Effect.fn("Slack.attachments.run")(
  function* <E, R>(
    input: IncomingEvent,
    run: (warning: string | undefined) => Effect.Effect<void, E, R>
  ): Effect.fn.Return<void, E, R> {
    const gathered = yield* gatherAttachments(input);

    yield* run(gathered.warning).pipe(
      Effect.ensuring(
        gathered.fetched > 0
          ? Effect.forkDetach(discardAttachments(gathered.dir))
          : Effect.void
      )
    );
  }
);
