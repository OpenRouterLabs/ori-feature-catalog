/**
 * attachment-download.ts — making a Slack attachment readable by the agent.
 *
 * `ChatTurnInput.prompt` is a string: there is no channel for inline images or
 * file content. So an attachment becomes readable the same way any other file
 * does — it lands on disk and the prompt names the path, and the agent opens
 * it with its own tools if it decides the file is worth reading.
 *
 * That ordering is the point. The untrusted-content warning is already in the
 * prompt beside the path, so the instruction-vs-data boundary is set before
 * the model ever looks inside.
 *
 * Three things this refuses to do:
 *
 *   - Follow an arbitrary URL. `url_private` is attacker-influenced data on an
 *     inbound event; only Slack's own file hosts are fetched, so a crafted
 *     event cannot turn the bot into an SSRF proxy against internal services.
 *   - Trust the filename as a path. A file named `../../.ssh/authorized_keys`
 *     must not escape the download directory.
 *   - Download without a ceiling. Slack allows very large uploads and the
 *     daemon is long-lived.
 *
 * Every step is an Effect, and each one is a named span: the download is the
 * one part of a turn that reaches the network before the turn exists, so when
 * a message is slow to answer this is where the trace has to show it.
 */

import { Effect, Schema } from "effect";

import { bestEffort } from "../../helpers/best-effort.ts";

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

/** Slack hosts that serve `url_private`. Anything else is not fetched. */
const ALLOWED_FILE_HOSTS: ReadonlySet<string> = new Set([
  "files.slack.com",
  "files-origin.slack.com",
]);

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;

const MAX_FILE_MIB = 25;
const MAX_TURN_MIB = 100;

/** Per-file ceiling. Large enough for screenshots and logs, not for archives. */
const MAX_FILE_BYTES = MAX_FILE_MIB * BYTES_PER_MIB;

/** Total per turn, so a message with fifty attachments cannot fill the disk. */
const MAX_TURN_BYTES = MAX_TURN_MIB * BYTES_PER_MIB;

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
/** Per file, so one stalled download cannot cost the whole turn. */
const DOWNLOAD_TIMEOUT_MS = SECONDS_PER_MINUTE * MS_PER_SECOND;

/** Long enough to stay recognisable, short of any filesystem's name limit. */
const MAX_NAME_CHARS = 128;

/**
 * Why one attachment did not make it.
 *
 * Nothing recovers from this — the loop below is best effort per file — but a
 * tagged failure names which file and which step in the trace, where a bare
 * `Error` would only say that something went wrong somewhere in the turn.
 */
class AttachmentError extends Schema.TaggedErrorClass<AttachmentError>()(
  "AttachmentError",
  {
    cause: Schema.Defect(),
    fileId: Schema.String,
    step: Schema.Literals(["fetch", "makeDir", "write"]),
  }
) {
  override get message(): string {
    return `The attachment "${this.fileId}" could not be ${this.step === "fetch" ? "fetched from Slack" : "written to disk"}`;
  }
}

/** The subset of an {@link AttachedFile} this needs — kept structural so the
 * caller passes its own list straight through. */
export interface DownloadableFile {
  readonly filetype: string;
  readonly id: string;
  readonly label: string;
  readonly urlPrivate: string;
}

interface DownloadedFile {
  readonly bytes: number;
  /** The Slack file id this came from, so callers join on it rather than name. */
  readonly id: string;
  readonly label: string;
  readonly path: string;
}

/**
 * Reduce a Slack filename to a safe basename.
 *
 * `basename` strips directory components, so traversal is gone; the remaining
 * filter keeps the result predictable on any filesystem. An empty result falls
 * back to the file id, which Slack guarantees.
 */
export const safeFileName = (name: string, fileId: string): string => {
  const base = basename(name)
    .replaceAll(/[^\w.-]/gu, "_")
    .replace(/^\.+/u, "");
  if (base === "" || base === "_") {
    return fileId;
  }
  return base.length > MAX_NAME_CHARS ? base.slice(-MAX_NAME_CHARS) : base;
};

export const isAllowedFileUrl = Effect.fn("Slack.attachments.isAllowedUrl")(
  function* (raw: string): Effect.fn.Return<boolean> {
    // `new URL` throws on anything that is not a URL, which is the same
    // answer as a URL pointing somewhere we do not allow.
    return yield* Effect.try(() =>
      ALLOWED_FILE_HOSTS.has(new URL(raw).hostname)
    ).pipe(Effect.orElseSucceed(() => false));
  }
);

let downloadSequence = 0;

/**
 * Where a turn's attachments land.
 *
 * Unique per call, not per thread. Downloads happen before the turn is
 * enqueued, so two messages arriving together in one thread download
 * concurrently even though their turns are serialised — sharing a directory
 * meant the first to finish deleted files the second was still naming.
 *
 * A Slack ts is `<digits>.<digits>`. Anything else is reduced to that shape:
 * dropping non-digits alone is not enough, because a run of dots survives and
 * `..` is still a path component.
 */
export const attachmentDirFor = (threadTs: string): string => {
  const digitsAndDots = threadTs.replaceAll(/[^\d.]/gu, "");
  const collapsed = digitsAndDots.replaceAll(/\.+/gu, ".").replace(/^\./u, "");
  downloadSequence += 1;
  return join(
    tmpdir(),
    "ori-slack-attachments",
    `${collapsed === "" ? "unknown-thread" : collapsed}-${downloadSequence}`
  );
};

interface DownloadDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly token: string;
  readonly writeDir: string;
}

/** Fetch one file's bytes, or undefined if it is not worth keeping. */
const fetchWithinLimits = Effect.fn("Slack.attachments.fetchFile")(function* (
  file: DownloadableFile,
  deps: DownloadDeps,
  budget: number
): Effect.fn.Return<Uint8Array | undefined, AttachmentError> {
  // Everything the old try/catch covered stays inside the thunk: a throw in a
  // `map` further down the pipe would be a defect, which no `catch` here
  // recovers, and this file's failure must stay this file's failure.
  return yield* Effect.tryPromise({
    catch: (cause) =>
      new AttachmentError({
        cause,
        fileId: file.id,
        step: "fetch",
      }),
    try: async () => {
      const response = await deps.fetch(file.urlPrivate, {
        // url_private is authenticated: without the bot token Slack serves an
        // HTML sign-in page, which would otherwise be written out as the file.
        headers: { authorization: `Bearer ${deps.token}` },
        // Downloads run BEFORE the turn is enqueued, so nothing else bounds
        // them — not the turn deadline, not the client's retry policy. A
        // stalled connection here means the message never becomes a turn at
        // all and the user is left with no reply and no reason.
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) {
        return undefined;
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      const tooBig =
        bytes.byteLength > MAX_FILE_BYTES || bytes.byteLength > budget;
      return bytes.byteLength === 0 || tooBig ? undefined : bytes;
    },
  });
});

/** Where one file's bytes land, extension restored when the name lacks one. */
const destinationFor = (
  file: DownloadableFile,
  writeDir: string
): { readonly label: string; readonly path: string } => {
  const name = safeFileName(file.label, file.id);
  const label =
    extname(name) === "" && file.filetype !== ""
      ? `${name}.${file.filetype}`
      : name;
  return {
    label,
    path: join(writeDir, `${file.id}-${label}`),
  };
};

/** Made once per turn, and only once a file is worth writing. */
const ensureWriteDir = Effect.fn("Slack.attachments.ensureDir")(function* (
  file: DownloadableFile,
  writeDir: string
): Effect.fn.Return<void, AttachmentError> {
  yield* Effect.tryPromise({
    catch: (cause) =>
      new AttachmentError({
        cause,
        fileId: file.id,
        step: "makeDir",
      }),
    // 0o700: tmpdir is shared, and these are someone else's Slack files.
    try: () =>
      mkdir(writeDir, {
        mode: 0o700,
        recursive: true,
      }),
  });
});

const writeDownload = Effect.fn("Slack.attachments.writeFile")(function* (
  file: DownloadableFile,
  writeDir: string,
  bytes: Uint8Array
): Effect.fn.Return<DownloadedFile, AttachmentError> {
  return yield* Effect.tryPromise({
    catch: (cause) =>
      new AttachmentError({
        cause,
        fileId: file.id,
        step: "write",
      }),
    // `destinationFor` belongs inside the thunk with the write it names: a
    // path this cannot build is this file's failure, not a defect.
    try: async () => {
      const { label, path } = destinationFor(file, writeDir);
      await writeFile(path, bytes);
      return {
        bytes: bytes.byteLength,
        id: file.id,
        label,
        path,
      };
    },
  });
});

/** What one file spends and whether the directory is already there. */
interface TurnBudget {
  budget: number;
  dirReady: boolean;
}

/**
 * One file, start to finish. Charges the turn's budget only for bytes that
 * reached the disk, and marks the directory made only once mkdir has said so —
 * a failed mkdir leaves the next file to try again.
 */
const downloadOne = Effect.fn("Slack.attachments.downloadOne")(function* (
  file: DownloadableFile,
  deps: DownloadDeps,
  turn: TurnBudget
): Effect.fn.Return<DownloadedFile | undefined, AttachmentError> {
  const bytes = yield* fetchWithinLimits(file, deps, turn.budget);
  if (bytes === undefined) {
    return undefined;
  }

  if (!turn.dirReady) {
    yield* ensureWriteDir(file, deps.writeDir);
    turn.dirReady = true;
  }

  const written = yield* writeDownload(file, deps.writeDir, bytes);
  turn.budget -= bytes.byteLength;
  return written;
});

/**
 * Download what is safe to download. Never fails: an attachment that cannot be
 * fetched is simply absent from the result, because a broken file must not
 * cost the user their turn.
 *
 * Sequential on purpose. The per-turn byte budget is spent as each file lands,
 * so whether the fortieth attachment is admitted depends on what the thirty-
 * nine before it cost. Running these concurrently would decide that against a
 * budget nobody had spent yet, and the ceiling that keeps a Slack thread from
 * filling the disk would only hold by luck.
 */
export const downloadAttachments = Effect.fn("Slack.attachments.download")(
  function* (
    files: readonly DownloadableFile[],
    deps: DownloadDeps
  ): Effect.fn.Return<readonly DownloadedFile[]> {
    const downloaded: DownloadedFile[] = [];
    const turn: TurnBudget = {
      budget: MAX_TURN_BYTES,
      dirReady: false,
    };

    for (const file of files) {
      if (!(yield* isAllowedFileUrl(file.urlPrivate)) || turn.budget <= 0) {
        continue;
      }

      // Best effort by design — see the module comment. One file that cannot
      // be fetched or written must not cost the turn the files beside it, so
      // the whole cause is swallowed here and nowhere else.
      const written = yield* downloadOne(file, deps, turn).pipe(
        Effect.catchCause(() => Effect.succeed(undefined))
      );
      if (written !== undefined) {
        downloaded.push(written);
      }
    }

    return downloaded;
  }
);

/**
 * Remove a turn's downloads.
 *
 * Without this every attachment the bot ever saw accumulates in tmpdir for the
 * daemon's lifetime — a slow disk leak, and a pile of other people's files
 * sitting around long after the turn that needed them.
 */
export const discardAttachments = Effect.fn("Slack.attachments.discard")(
  function* (dir: string): Effect.fn.Return<void> {
    yield* Effect.tryPromise(() =>
      rm(dir, {
        force: true,
        recursive: true,
      })
    ).pipe(
      // Cleanup is best effort; a failure here must not fail the turn.
      bestEffort
    );
  }
);
