/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * attachments.ts — files on the way in, and cleaned up on the way out.
 */

import { Effect } from "effect";

import type { RawSlackMessage } from "../../client/index.ts";

import {
  attachmentDirFor,
  discardAttachments,
  downloadAttachments,
} from "./attachment-download.ts";
import { attachedFiles, untrustedFilesWarning } from "./untrusted-files.ts";

/** What a message is carrying, and where it landed. */
interface TurnAttachments {
  readonly dir: string;
  readonly fetched: number;
  readonly warning: string | undefined;
}

interface IncomingEvent {
  readonly event: RawSlackMessage;
  readonly token: string;
}

/**
 * Everything the turn needs from its attachments, and what to clean up after.
 */
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

/**
 * Fetch the event's attachments, run the turn, then discard them.
 *
 * Downloaded BEFORE the turn so the prompt can name real paths, and discarded
 * in an `ensuring` — an earlier version ran the cleanup as a trailing statement
 * and it was silently dropped in a refactor, leaving other people's files on
 * disk with nothing to catch it. Best effort: an unfetchable attachment is
 * still listed, just without a path the agent can open.
 *
 * `ensuring` rather than the `finally` it replaces, and wider than it: a
 * value, a failure, a defect and an interrupt all run it, where a `finally`
 * covered the first three and the caller — a turn that a steer can interrupt —
 * produces the fourth.
 *
 * The discard is forked detached rather than awaited, so cleanup never delays
 * the answer and outlives the turn that owned the files. It was two
 * `runPromise`s until `turn-routes.ts` became Effect itself; there is no edge
 * left here to cross.
 */
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
