import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Layer, Option } from "effect";

import { withRepoLock } from "#src/lock/index.ts";
import { previewPaths, repoSlug } from "#src/paths.ts";
import { recordingProcessGroupsLayer } from "#src/process-groups/test-support.ts";
import { describe, expect, it } from "#src/effect-bun-test.ts";

const REPO = "acme/web";
const OTHER_PID = 4242;

const lockFixture = (alive: boolean) =>
  Layer.merge(
    BunServicesLayer,
    recordingProcessGroupsLayer(undefined, {
      ownPid: 1,
      alive: (pid) => alive && pid === OTHER_PID,
    })
  );

const heldBy = Effect.fn(function* (root: string, owner: string | undefined) {
  const fs = yield* FileSystem.FileSystem;
  const directory = `${previewPaths(root).root}/locks/${repoSlug(REPO)}`;
  yield* fs.makeDirectory(directory, { recursive: true });
  if (owner !== undefined) {
    yield* fs.writeFileString(`${directory}/owner.json`, owner);
  }
  return directory;
});

describe("withRepoLock", () => {
  it.effect("runs the effect under a free lock and releases it after", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const paths = previewPaths(root);
      const result = yield* withRepoLock(paths, REPO, Effect.succeed("ran"), "skip");
      expect(result).toEqual(Option.some("ran"));
      expect(yield* fs.exists(`${paths.root}/locks/${repoSlug(REPO)}`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(lockFixture(false)))
  );

  it.effect("skips while a live process holds the lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* heldBy(root, JSON.stringify({ pid: OTHER_PID }));
      const result = yield* withRepoLock(
        previewPaths(root),
        REPO,
        Effect.succeed("ran"),
        "skip"
      );
      expect(result).toEqual(Option.none());
    }).pipe(Effect.scoped, Effect.provide(lockFixture(true)))
  );

  it.effect("skips a lock created a moment ago whose owner is not written yet", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* heldBy(root, undefined);
      const result = yield* withRepoLock(
        previewPaths(root),
        REPO,
        Effect.succeed("ran"),
        "skip"
      );
      expect(result).toEqual(Option.none());
    }).pipe(Effect.scoped, Effect.provide(lockFixture(true)))
  );

  it.effect("reclaims a lock whose owner died and runs the effect on the next try", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* heldBy(root, JSON.stringify({ pid: OTHER_PID }));
      const result = yield* withRepoLock(
        previewPaths(root),
        REPO,
        Effect.succeed("ran"),
        "wait"
      );
      expect(result).toEqual(Option.some("ran"));
    }).pipe(Effect.scoped, Effect.provide(lockFixture(false))),
    10_000
  );
});
