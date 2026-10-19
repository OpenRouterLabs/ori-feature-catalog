import {
  Clock,
  Effect,
  FileSystem,
  Option,
  Result,
  Schedule,
  Schema,
} from "effect";

import type { PreviewPaths } from "../paths.ts";
import type { ProcessGroups } from "../process-groups/index.ts";
import type { ProcessRef } from "../process/index.ts";

import { PreviewError } from "../errors.ts";
import { repoSlug } from "../paths.ts";
import { currentProcess, isAlive } from "../process/index.ts";
import { ProcessRefJson } from "../schemas.ts";
import { readJsonFile } from "../status/index.ts";

const LOCK_OWNER_FILE = "owner.json";

const OWNERLESS_GRACE_MS = 30_000;

const decodeOwner = Schema.decodeUnknownEffect(ProcessRefJson);
const encodeOwner = Schema.encodeEffect(ProcessRefJson);

const lockDirectory = (paths: PreviewPaths, repo: string): string =>
  `${paths.root}/locks/${repoSlug(repo)}`;

const sameOwner = (left: ProcessRef, right: ProcessRef): boolean =>
  left.pid === right.pid && left.startedAt === right.startedAt;

const isFreshlyCreated = Effect.fn("Preview.lock.isFreshlyCreated")(function* (
  directory: string
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(directory).pipe(Effect.option);
  const created = Option.flatMap(info, (stat) => stat.mtime);
  if (Option.isNone(created)) {
    return false;
  }
  const now = yield* Clock.currentTimeMillis;
  return now - created.value.getTime() < OWNERLESS_GRACE_MS;
});

const isHeld = Effect.fn("Preview.lock.isHeld")(function* (
  directory: string,
  owner: Option.Option<ProcessRef>,
  self: ProcessRef
) {
  if (Option.isNone(owner)) {
    return yield* isFreshlyCreated(directory);
  }
  return sameOwner(owner.value, self) || (yield* isAlive(owner.value));
});

const tryAcquire = Effect.fn("Preview.lock.tryAcquire")(function* (
  directory: string,
  self: ProcessRef
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(directory.slice(0, directory.lastIndexOf("/")), {
    recursive: true,
  });
  const created = yield* fs.makeDirectory(directory).pipe(Effect.result);
  if (Result.isSuccess(created)) {
    yield* fs.writeFileString(
      `${directory}/${LOCK_OWNER_FILE}`,
      yield* encodeOwner(self).pipe(Effect.orDie)
    );
    return true;
  }
  const owner = yield* readJsonFile(
    `${directory}/${LOCK_OWNER_FILE}`,
    decodeOwner
  );
  if (!(yield* isHeld(directory, owner, self))) {
    yield* fs.remove(directory, { recursive: true, force: true });
  }
  return false;
});

const release = (directory: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.remove(directory, { recursive: true, force: true })
    ),
    Effect.ignore
  );

export const withRepoLock = <A, E, R>(
  paths: PreviewPaths,
  repo: string,
  effect: Effect.Effect<A, E, R>,
  wait: "wait" | "skip"
): Effect.Effect<
  Option.Option<A>,
  E | PreviewError,
  R | FileSystem.FileSystem | ProcessGroups
> => {
  const directory = lockDirectory(paths, repo);
  const acquire = currentProcess.pipe(
    Effect.flatMap((self) => tryAcquire(directory, self)),
    Effect.mapError(
      () =>
        new PreviewError({
          code: "state_unreadable",
          detail: `Could not take the preview lock for ${repo}.`,
        })
    )
  );
  const acquired =
    wait === "skip"
      ? acquire
      : acquire.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (held) => held,
          })
        );
  return acquired.pipe(
    Effect.flatMap((held) =>
      held
        ? effect.pipe(Effect.asSome, Effect.ensuring(release(directory)))
        : Effect.succeed(Option.none<A>())
    )
  );
};
