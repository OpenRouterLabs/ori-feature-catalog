/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * attachments.ts — files on the way in, and cleaned up on the way out.
 */

import { Effect } from "effect";

import type { RawSlackMessage } from "../../client/listeners.ts";

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
 * in a `finally` — an earlier version ran the cleanup as a trailing statement
 * and it was silently dropped in a refactor, leaving other people's files on
 * disk with nothing to catch it. Best effort: an unfetchable attachment is
 * still listed, just without a path the agent can open.
 *
 * The two `runPromise`s here are the edge, not a round trip: `run` is a
 * promise-returning callback owned by the caller, and the discard is fired and
 * not awaited so cleanup never delays the answer. Both fold away the day the
 * turn routes are Effect themselves.
 */
export const withAttachments = async (
  input: IncomingEvent,
  run: (warning: string | undefined) => Promise<void>
): Promise<void> => {
  const gathered = await Effect.runPromise(gatherAttachments(input));

  await run(gathered.warning).finally(() => {
    if (gathered.fetched > 0) {
      void Effect.runPromise(discardAttachments(gathered.dir));
    }
  });
};
