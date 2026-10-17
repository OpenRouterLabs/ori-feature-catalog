import type { PlatformError } from "effect";

import {
  Clock,
  DateTime,
  Effect,
  FileSystem,
  Option,
  Path,
  Predicate,
  Schema,
} from "effect";
import { Hex } from "effect/encoding";

export const ARTIFACTS_DIRECTORY = "artifacts";

export const ARTIFACT_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'";
const MANIFEST_FILE = "artifact.json";
const VERSION_FILE = /^v([1-9][0-9]*)\.html$/u;
const MAX_SAVE_ATTEMPTS = 3;

export const ArtifactNameSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/u))
);

const matchesArtifactName = Schema.is(ArtifactNameSchema);

export const isArtifactName = (name: string): boolean =>
  matchesArtifactName(name);

export const ArtifactVersionSchema = Schema.Struct({
  created_at: Schema.String,
  sha256: Schema.String,
  size: Schema.Int,
  version: Schema.Int,
});
export type ArtifactVersion = typeof ArtifactVersionSchema.Type;

export const ArtifactManifestSchema = Schema.Struct({
  name: ArtifactNameSchema,
  title: Schema.String,
  versions: Schema.Array(ArtifactVersionSchema),
});
export type ArtifactManifest = typeof ArtifactManifestSchema.Type;

export const ArtifactSummarySchema = Schema.Struct({
  latest_version: Schema.Int,
  name: ArtifactNameSchema,
  title: Schema.String,
  updated_at: Schema.String,
  versions: Schema.Array(ArtifactVersionSchema),
});
export type ArtifactSummary = typeof ArtifactSummarySchema.Type;

export class ArtifactStoreError extends Schema.TaggedError<ArtifactStoreError>()(
  "ArtifactStoreError",
  { cause: Schema.optionalKey(Schema.Defect()), detail: Schema.String }
) {
  override readonly message = this.detail;
}

const ManifestJson = Schema.fromJsonString(ArtifactManifestSchema);
const decodeManifest = Schema.decodeUnknownOption(ManifestJson);
const encodeManifest = Schema.encodeEffect(ManifestJson);

const storeFailure =
  (detail: string) =>
  (cause: PlatformError.PlatformError | Schema.SchemaError) =>
    new ArtifactStoreError({ cause, detail });

const artifactDirectory = (
  path: Path.Path,
  workspaceRoot: string,
  name: string
) => path.join(workspaceRoot, ARTIFACTS_DIRECTORY, name);

export const artifactVersionFile = (
  path: Path.Path,
  workspaceRoot: string,
  name: string,
  version: number
): string =>
  path.join(artifactDirectory(path, workspaceRoot, name), `v${version}.html`);

const readManifest = Effect.fn("WorkspaceArtifacts.readManifest")(function* (
  workspaceRoot: string,
  name: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs
    .readFileString(
      path.join(artifactDirectory(path, workspaceRoot, name), MANIFEST_FILE)
    )
    .pipe(Effect.option);
  return Option.flatMap(text, decodeManifest).pipe(
    Option.filter((manifest) => manifest.name === name)
  );
});

const summarize = (
  manifest: ArtifactManifest
): Option.Option<ArtifactSummary> => {
  const latest = manifest.versions.at(-1);
  return Predicate.isUndefined(latest)
    ? Option.none()
    : Option.some({
        latest_version: latest.version,
        name: manifest.name,
        title: manifest.title,
        updated_at: latest.created_at,
        versions: manifest.versions,
      });
};

export const listWorkspaceArtifacts = Effect.fn("WorkspaceArtifacts.list")(
  function* (workspaceRoot: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = yield* fs
      .readDirectory(path.join(workspaceRoot, ARTIFACTS_DIRECTORY))
      .pipe(Effect.orElseSucceed((): readonly string[] => []));
    const manifests = yield* Effect.forEach(
      names.filter(isArtifactName),
      (name) => readManifest(workspaceRoot, name)
    );
    return manifests
      .flatMap((manifest) =>
        Option.toArray(Option.flatMap(manifest, summarize))
      )
      .toSorted((left, right) =>
        right.updated_at.localeCompare(left.updated_at)
      );
  }
);

export const readWorkspaceArtifact = Effect.fn("WorkspaceArtifacts.read")(
  function* (
    workspaceRoot: string,
    name: string,
    version: Option.Option<number>
  ) {
    if (!isArtifactName(name)) {
      return Option.none();
    }
    const manifest = yield* readManifest(workspaceRoot, name);
    const wanted = Option.flatMap(manifest, (found) =>
      Option.fromNullishOr(
        Option.isSome(version)
          ? found.versions.find((entry) => entry.version === version.value)
          : found.versions.at(-1)
      )
    );
    if (Option.isNone(wanted)) {
      return Option.none();
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const html = yield* fs
      .readFileString(
        artifactVersionFile(path, workspaceRoot, name, wanted.value.version)
      )
      .pipe(Effect.option);
    return Option.map(html, (text) => ({
      html: text,
      version: wanted.value.version,
    }));
  }
);

export const deleteWorkspaceArtifact = Effect.fn("WorkspaceArtifacts.delete")(
  function* (workspaceRoot: string, name: string) {
    if (
      !isArtifactName(name) ||
      Option.isNone(yield* readManifest(workspaceRoot, name))
    ) {
      return false;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs
      .remove(artifactDirectory(path, workspaceRoot, name), { recursive: true })
      .pipe(Effect.mapError(storeFailure(`Failed to delete artifact ${name}`)));
    return true;
  }
);

const utf8 = new TextEncoder();

const sha256Hex = (bytes: Uint8Array<ArrayBuffer>) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)).pipe(
    Effect.map((digest) => Hex.encode(new Uint8Array(digest)))
  );

const highestVersionOnDisk = Effect.fn("WorkspaceArtifacts.highestVersion")(
  function* (directory: string) {
    const fs = yield* FileSystem.FileSystem;
    const files: readonly string[] = yield* fs
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed((): readonly string[] => []));
    return files.reduce((highest, file) => {
      const match = VERSION_FILE.exec(file);
      return match === null ? highest : Math.max(highest, Number(match[1]));
    }, 0);
  }
);

const writeNextVersion = Effect.fn("WorkspaceArtifacts.writeNextVersion")(
  function* (
    workspaceRoot: string,
    name: string,
    html: string,
    previous: Option.Option<ArtifactManifest>
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = artifactDirectory(path, workspaceRoot, name);
    yield* fs
      .makeDirectory(directory, { recursive: true })
      .pipe(Effect.mapError(storeFailure(`Failed to create ${directory}`)));
    const recorded = Option.match(previous, {
      onNone: () => 0,
      onSome: (manifest) => manifest.versions.at(-1)?.version ?? 0,
    });
    for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt += 1) {
      const version =
        Math.max(recorded, yield* highestVersionOnDisk(directory)) + 1;
      const file = artifactVersionFile(path, workspaceRoot, name, version);
      const written = yield* fs
        .writeFileString(file, html, { flag: "wx" })
        .pipe(
          Effect.as(true),
          Effect.catchTag("PlatformError", (error) =>
            Predicate.isTagged(error.reason, "AlreadyExists")
              ? Effect.succeed(false)
              : Effect.fail(storeFailure(`Failed to write ${file}`)(error))
          )
        );
      if (written) {
        return { file, version };
      }
    }
    return yield* new ArtifactStoreError({
      detail: `Another save of ${name} kept taking the next version; save again.`,
    });
  }
);

const SAVE_LOCK = ".save.lock";
const SAVE_LOCK_ATTEMPTS = 200;
const SAVE_LOCK_RETRY = "25 millis";
const SAVE_LOCK_STALE_MILLIS = 30_000;

const lockIsStale = Effect.fn("WorkspaceArtifacts.lockIsStale")(function* (
  lock: string
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(lock).pipe(Effect.option);
  const now = yield* Clock.currentTimeMillis;
  return Option.exists(
    Option.flatMap(info, (found) => found.mtime),
    (mtime) => now - mtime.getTime() > SAVE_LOCK_STALE_MILLIS
  );
});

const acquireSaveLock = Effect.fn("WorkspaceArtifacts.acquireSaveLock")(
  function* (directory: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lock = path.join(directory, SAVE_LOCK);
    yield* fs
      .makeDirectory(directory, { recursive: true })
      .pipe(Effect.mapError(storeFailure(`Failed to create ${directory}`)));
    for (let attempt = 0; attempt < SAVE_LOCK_ATTEMPTS; attempt += 1) {
      const acquired = yield* fs.makeDirectory(lock).pipe(
        Effect.as(true),
        Effect.catchTag("PlatformError", (error) =>
          Predicate.isTagged(error.reason, "AlreadyExists")
            ? Effect.succeed(false)
            : Effect.fail(storeFailure(`Failed to lock ${directory}`)(error))
        )
      );
      if (acquired) {
        return lock;
      }
      if (yield* lockIsStale(lock)) {
        yield* fs.remove(lock, { recursive: true }).pipe(Effect.ignore);
        continue;
      }
      yield* Effect.sleep(SAVE_LOCK_RETRY);
    }
    return yield* new ArtifactStoreError({
      detail: `Another save is holding ${lock}; save again once it finishes.`,
    });
  }
);

const releaseSaveLock = (lock: string) =>
  FileSystem.FileSystem.use((fs) => fs.remove(lock, { recursive: true })).pipe(
    Effect.ignore
  );

const saveUnderLock = Effect.fn("WorkspaceArtifacts.saveUnderLock")(function* (
  workspaceRoot: string,
  page: {
    readonly html: string;
    readonly name: string;
    readonly title: Option.Option<string>;
  }
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const previous = yield* readManifest(workspaceRoot, page.name);
  const { file, version } = yield* writeNextVersion(
    workspaceRoot,
    page.name,
    page.html,
    previous
  );
  const bytes = utf8.encode(page.html);
  const entry: ArtifactVersion = {
    created_at: DateTime.formatIso(yield* DateTime.now),
    sha256: yield* sha256Hex(bytes),
    size: bytes.byteLength,
    version,
  };
  const manifest: ArtifactManifest = {
    name: page.name,
    title: Option.getOrElse(page.title, () =>
      Option.match(previous, {
        onNone: () => page.name,
        onSome: (found) => found.title,
      })
    ),
    versions: [
      ...Option.match(previous, {
        onNone: () => [],
        onSome: (found) => found.versions,
      }),
      entry,
    ],
  };
  const directory = artifactDirectory(path, workspaceRoot, page.name);
  const staging = path.join(directory, `.${MANIFEST_FILE}.${version}.tmp`);
  const json = yield* encodeManifest(manifest).pipe(
    Effect.mapError(
      storeFailure(`Failed to encode the manifest of ${page.name}`)
    )
  );
  yield* fs.writeFileString(staging, `${json}\n`).pipe(
    Effect.flatMap(() =>
      fs.rename(staging, path.join(directory, MANIFEST_FILE))
    ),
    Effect.mapError(
      storeFailure(`Failed to write the manifest of ${page.name}`)
    )
  );
  return { entry, file, manifest };
});

export const saveWorkspaceArtifact = Effect.fn("WorkspaceArtifacts.save")(
  function* (
    workspaceRoot: string,
    page: {
      readonly html: string;
      readonly name: string;
      readonly title: Option.Option<string>;
    }
  ) {
    const path = yield* Path.Path;
    return yield* Effect.acquireUseRelease(
      acquireSaveLock(artifactDirectory(path, workspaceRoot, page.name)),
      () => saveUnderLock(workspaceRoot, page),
      releaseSaveLock
    );
  }
);
