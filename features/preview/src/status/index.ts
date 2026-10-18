import { DateTime, Effect, FileSystem, Option, Schema } from "effect";

import type { PreviewPaths } from "#src/paths.ts";
import type { AlternateServer, PreviewStatus } from "#src/schemas.ts";

import { alternatePath, statusPath } from "#src/paths.ts";
import { AlternateServerSchema, PreviewStatusSchema } from "#src/schemas.ts";

const decodeStatus = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PreviewStatusSchema)
);
const encodeStatus = Schema.encodeEffect(
  Schema.fromJsonString(PreviewStatusSchema, { space: 2 })
);
const decodeAlternate = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AlternateServerSchema)
);
const encodeAlternate = Schema.encodeEffect(
  Schema.fromJsonString(AlternateServerSchema, { space: 2 })
);

export const readJsonFile = Effect.fn("Preview.readJsonFile")(function* <A>(
  path: string,
  decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(path).pipe(Effect.option);
  if (Option.isNone(raw)) {
    return Option.none<A>();
  }
  return yield* decode(raw.value).pipe(Effect.option);
});

export const writeFileAtomic = Effect.fn("Preview.writeFileAtomic")(function* (
  directory: string,
  path: string,
  content: string
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(directory, { recursive: true });
  const staging = `${path}.${yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis))}.tmp`;
  yield* fs.writeFileString(staging, content);
  yield* fs.rename(staging, path);
});

export const readPreviewStatus = (paths: PreviewPaths, repo: string) =>
  readJsonFile(statusPath(paths, repo), decodeStatus);

export const readAllPreviewStatuses = Effect.fn("Preview.readAllStatuses")(
  function* (paths: PreviewPaths) {
    const fs = yield* FileSystem.FileSystem;
    const names = yield* fs
      .readDirectory(paths.status)
      .pipe(Effect.orElseSucceed(() => []));
    const decoded = yield* Effect.forEach(
      names.filter((name) => name.endsWith(".json")).toSorted(),
      (name) => readJsonFile(`${paths.status}/${name}`, decodeStatus)
    );
    return decoded.flatMap(Option.toArray);
  }
);

export const writePreviewStatus = Effect.fn("Preview.writeStatus")(function* (
  paths: PreviewPaths,
  status: Omit<PreviewStatus, "updatedAt">
) {
  const updatedAt = DateTime.formatIso(yield* DateTime.now);
  const encoded = yield* encodeStatus({ ...status, updatedAt }).pipe(
    Effect.orDie
  );
  yield* writeFileAtomic(paths.status, statusPath(paths, status.repo), encoded);
});

export const touchPreview = Effect.fn("Preview.touch")(function* (
  paths: PreviewPaths,
  status: PreviewStatus
) {
  const lastUsedAt = DateTime.formatIso(yield* DateTime.now);
  yield* writePreviewStatus(paths, { ...status, lastUsedAt });
});

export const readAlternate = (paths: PreviewPaths, repo: string) =>
  readJsonFile(alternatePath(paths, repo), decodeAlternate);

export const clearAlternate = Effect.fn("Preview.clearAlternate")(function* (
  paths: PreviewPaths,
  repo: string
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(alternatePath(paths, repo), { force: true });
});

export const writeAlternate = Effect.fn("Preview.writeAlternate")(function* (
  paths: PreviewPaths,
  alternate: AlternateServer
) {
  const encoded = yield* encodeAlternate(alternate).pipe(Effect.orDie);
  yield* writeFileAtomic(
    paths.alternates,
    alternatePath(paths, alternate.repo),
    encoded
  );
});

export const claimedPorts = Effect.fn("Preview.claimedPorts")(function* (
  paths: PreviewPaths,
  exceptRepo?: string
) {
  const fs = yield* FileSystem.FileSystem;
  const statuses = yield* readAllPreviewStatuses(paths);
  const alternateNames = yield* fs
    .readDirectory(paths.alternates)
    .pipe(Effect.orElseSucceed(() => []));
  const alternates = yield* Effect.forEach(
    alternateNames.filter((name) => name.endsWith(".json")),
    (name) => readJsonFile(`${paths.alternates}/${name}`, decodeAlternate)
  );
  return new Set([
    ...statuses
      .filter((status) => status.repo !== exceptRepo)
      .flatMap((status) => Option.toArray(Option.fromNullishOr(status.port))),
    ...alternates.flatMap(Option.toArray).map((alternate) => alternate.port),
  ]);
});
