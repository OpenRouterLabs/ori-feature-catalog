import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Layer, Option } from "effect";

import { startAlternate } from "#src/alternate/index.ts";
import { previewPaths } from "#src/paths.ts";
import {
  emptyProcessGroupsRecording,
  recordingProcessGroupsLayer,
} from "#src/process-groups/test-support.ts";
import { readAlternate, writeAlternate } from "#src/status/index.ts";
import { scriptedTcpProbeLayer } from "#src/tcp-probe/test-support.ts";
import { describe, expect, it } from "#src/effect-bun-test.ts";

const LIVE_PID = 801;

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
});
