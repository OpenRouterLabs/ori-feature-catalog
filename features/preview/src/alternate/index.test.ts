import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Layer, Option } from "effect";

import { startAlternate } from "#src/alternate/index.ts";
import { PREVIEW_UID, previewPaths, repoCheckout } from "#src/paths.ts";
import {
  emptyProcessGroupsRecording,
  recordingProcessGroupsLayer,
} from "#src/process-groups/test-support.ts";
import { chownRecordingServicesLayer } from "#src/sandbox/test-support.ts";
import { readAlternate, writeAlternate } from "#src/status/index.ts";
import { scriptedTcpProbeLayer } from "#src/tcp-probe/test-support.ts";
import { describe, expect, it } from "#src/effect-bun-test.ts";

const LIVE_PID = 801;

const STARTED_PID = 802;

const running = {
  repo: "acme/web",
  directory: "/preview/work/web",
  port: 41_003,
  process: { pid: LIVE_PID },
  url: "http://127.0.0.1:41003/",
};

const fixture = (recording = emptyProcessGroupsRecording()) => {
  const terminated = { value: false };
  const alive = (pid: number): boolean => {
    if (pid === -LIVE_PID) {
      terminated.value = true;
      return true;
    }
    return !terminated.value && pid === LIVE_PID;
  };
  return Layer.mergeAll(
    BunServicesLayer,
    recordingProcessGroupsLayer(recording, { ownPid: 1, alive }),
    scriptedTcpProbeLayer()
  );
};

const startable = (recording = emptyProcessGroupsRecording(), serverStays = true) =>
  Layer.mergeAll(
    chownRecordingServicesLayer(),
    recordingProcessGroupsLayer(recording, {
      ownPid: 1,
      spawnedPid: STARTED_PID,
      alive: (pid) => serverStays && Math.abs(pid) === STARTED_PID,
    }),
    scriptedTcpProbeLayer({
      get: () => Effect.succeed({ status: 200, body: "<html>fixed</html>" }),
    })
  );

const changedCopy = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "ori-preview-" });
  const paths = previewPaths(`${root}/workspace`, `${root}/sandbox`);
  const checkout = repoCheckout(paths, "acme/web");
  yield* fs.makeDirectory(checkout, { recursive: true });
  yield* fs.writeFileString(`${checkout}/package.json`, `{"scripts":{"dev":"vite"}}`);
  return { paths, directory: `${paths.work}/fix` };
});

describe("startAlternate", () => {
  it.effect("reuses the changed copy's running server for the same directory", () => {
    const recording = emptyProcessGroupsRecording();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const paths = previewPaths(root);
      yield* writeAlternate(paths, running);
      const alternate = yield* startAlternate({ paths, repo: "acme/web", directory: running.directory, env: {} });
      expect(alternate).toEqual(running);
      expect(recording.spawned).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(fixture(recording)));
  });

  it.effect("stops the old server before starting one for another directory, and records nothing when that fails", () => {
    const recording = emptyProcessGroupsRecording();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const paths = previewPaths(root);
      yield* writeAlternate(paths, running);
      const error = yield* startAlternate({
        paths,
        repo: "acme/web",
        directory: `${root}/changed`,
        env: {},
      }).pipe(Effect.flip);
      expect(error._tag).toBe("PreviewError");
      expect(recording.signals).toContainEqual({ pid: -LIVE_PID, signal: "SIGTERM" });
      expect(Option.getOrUndefined(yield* readAlternate(paths, "acme/web"))?.directory).toBe(running.directory);
    }).pipe(Effect.scoped, Effect.provide(fixture(recording)));
  });

  it.effect("hands the changed copy to the preview user and runs it from that directory", () => {
    const recording = emptyProcessGroupsRecording();
    return Effect.gen(function* () {
      const { paths, directory } = yield* changedCopy;
      yield* startAlternate({ paths, repo: "acme/web", directory, env: {} });
      expect(recording.ran.map((run) => run.command[0])).toContain("find");
      expect(recording.spawned[0]?.cwd).toBe(directory);
      expect(recording.spawned[0]?.command).toContain(`--reuid=${PREVIEW_UID}`);
    }).pipe(Effect.scoped, Effect.provide(startable(recording)));
  });

  it.effect("records the started server on its own port, so the screenshot tool can find it", () =>
    Effect.gen(function* () {
      const { paths, directory } = yield* changedCopy;
      const alternate = yield* startAlternate({ paths, repo: "acme/web", directory, env: {} });
      expect(alternate.port).toBe(41_000);
      expect(alternate.process.pid).toBe(STARTED_PID);
      expect(Option.getOrUndefined(yield* readAlternate(paths, "acme/web"))).toEqual(alternate);
    }).pipe(Effect.scoped, Effect.provide(startable()))
  );

  it.effect("names the directory and port when the changed copy exits before serving", () =>
    Effect.gen(function* () {
      const { paths, directory } = yield* changedCopy;
      const error = yield* startAlternate({ paths, repo: "acme/web", directory, env: {} }).pipe(Effect.flip);
      expect(error).toMatchObject({
        code: "start_failed",
        detail: expect.stringContaining(`The changed copy in ${directory} did not start on port 41000.`),
      });
      expect(Option.isNone(yield* readAlternate(paths, "acme/web"))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(startable(emptyProcessGroupsRecording(), false)))
  );
});
