import { Effect, Schema } from "effect";

import { bestEffort } from "../../helpers/best-effort.ts";

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

const ALLOWED_FILE_HOSTS: ReadonlySet<string> = new Set([
  "files.slack.com",
  "files-origin.slack.com",
]);

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;

const MAX_FILE_MIB = 25;
const MAX_TURN_MIB = 100;

const MAX_FILE_BYTES = MAX_FILE_MIB * BYTES_PER_MIB;

const MAX_TURN_BYTES = MAX_TURN_MIB * BYTES_PER_MIB;

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const DOWNLOAD_TIMEOUT_MS = SECONDS_PER_MINUTE * MS_PER_SECOND;

const MAX_NAME_CHARS = 128;

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

export interface DownloadableFile {
  readonly filetype: string;
  readonly id: string;
  readonly label: string;
  readonly urlPrivate: string;
}

interface DownloadedFile {
  readonly bytes: number;
  readonly id: string;
  readonly label: string;
  readonly path: string;
}

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
    return yield* Effect.try(() =>
      ALLOWED_FILE_HOSTS.has(new URL(raw).hostname)
    ).pipe(Effect.orElseSucceed(() => false));
  }
);

let downloadSequence = 0;

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

const fetchWithinLimits = Effect.fn("Slack.attachments.fetchFile")(function* (
  file: DownloadableFile,
  deps: DownloadDeps,
  budget: number
): Effect.fn.Return<Uint8Array | undefined, AttachmentError> {
  return yield* Effect.tryPromise({
    catch: (cause) =>
      new AttachmentError({
        cause,
        fileId: file.id,
        step: "fetch",
      }),
    try: async () => {
      const response = await deps.fetch(file.urlPrivate, {
        headers: { authorization: `Bearer ${deps.token}` },
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

interface TurnBudget {
  budget: number;
  dirReady: boolean;
}

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

export const discardAttachments = Effect.fn("Slack.attachments.discard")(
  function* (dir: string): Effect.fn.Return<void> {
    yield* Effect.tryPromise(() =>
      rm(dir, {
        force: true,
        recursive: true,
      })
    ).pipe(
      bestEffort
    );
  }
);
