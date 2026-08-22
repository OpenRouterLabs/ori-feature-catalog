/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * attachments.ts — files on the way in, and cleaned up on the way out.
 */

import type { RawSlackMessage } from "../../client/listeners.ts";

import {
  attachmentDirFor,
  discardAttachments,
  downloadAttachments,
} from "./attachment-download.ts";
import { attachedFiles, untrustedFilesWarning } from "./untrusted-files.ts";

/**
 * Fetch the event's attachments, run the turn, then discard them.
 *
 * Downloaded BEFORE the turn so the prompt can name real paths, and discarded
 * in a `finally` — an earlier version ran the cleanup as a trailing statement
 * and it was silently dropped in a refactor, leaving other people's files on
 * disk with nothing to catch it. Best effort: an unfetchable attachment is
 * still listed, just without a path the agent can open.
 */
export const withAttachments = async (
  input: { readonly event: RawSlackMessage; readonly token: string },
  run: (warning: string | undefined) => Promise<void>
): Promise<void> => {
  const threadTs = input.event.thread_ts ?? input.event.ts ?? "";
  const attachmentDir = attachmentDirFor(threadTs);
  const files = attachedFiles(input.event);
  const fetched = await downloadAttachments(
    files.filter((file) => file.urlPrivate !== "" && file.id !== ""),
    {
      fetch: globalThis.fetch,
      token: input.token,
      writeDir: attachmentDir,
    }
  );
  const pathById = new Map(fetched.map((file) => [file.id, file.path]));

  await run(
    untrustedFilesWarning(
      files.map((file) => ({
        ...file,
        path: pathById.get(file.id),
      }))
    )
  ).finally(() => {
    if (fetched.length > 0) {
      void discardAttachments(attachmentDir);
    }
  });
};
