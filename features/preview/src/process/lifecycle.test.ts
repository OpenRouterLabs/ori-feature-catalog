import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Layer } from "effect";

import {
  emptyProcessGroupsRecording,
  recordingProcessGroupsLayer,
} from "../process-groups/test-support.ts";
import {
  ensurePortFree,
  killGroup,
  runToLog,
  shellCommand,
  spawnDetached,
  tailLog,
} from "./index.ts";
import { scriptedTcpProbeLayer } from "../tcp-probe/test-support.ts";
import { describe, expect, it } from "../effect-bun-test.ts";

const spawn = (logPath: string) => ({
  command: shellCommand("true"),
  cwd: "/",
  env: {},
  logPath,
});

describe("spawnDetached and runToLog", () => {
  it.effect("create the log directory and hand the command to the process groups", () => {
    const recording = emptyProcessGroupsRecording();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const ref = yield* spawnDetached(spawn(`${root}/logs/dev.log`));
      expect(ref.pid).toBe(4321);
      expect(yield* runToLog(spawn(`${root}/other/install.log`))).toBe(3);
      expect(yield* fs.exists(`${root}/logs`)).toBe(true);
      expect(yield* fs.exists(`${root}/other`)).toBe(true);
      expect(recording.spawned.map((input) => input.command)).toEqual([["/bin/sh", "-c", "true"]]);
      expect(recording.ran).toHaveLength(1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(
          BunServicesLayer,
          recordingProcessGroupsLayer(recording, { spawnedPid: 4321, exitCode: 3 })
        )
      )
    );
  });
});

describe("killGroup", () => {
  it.effect("does nothing for a process that is already gone", () => {
    const recording = emptyProcessGroupsRecording();
    return Effect.gen(function* () {
      yield* killGroup(undefined);
      yield* killGroup({ pid: 99 });
      expect(recording.signals).toEqual([{ pid: 99, signal: 0 }]);
    }).pipe(
      Effect.provide(Layer.merge(BunServicesLayer, recordingProcessGroupsLayer(recording)))
    );
  });

  it.effect("terminates a live process group, then stops once it is gone", () => {
    const recording = emptyProcessGroupsRecording();
    const alive = { value: true };
    return Effect.gen(function* () {
      yield* killGroup({ pid: 99 });
      expect(recording.signals.filter((sent) => sent.signal !== 0)).toEqual([
        { pid: -99, signal: "SIGTERM" },
      ]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          BunServicesLayer,
          recordingProcessGroupsLayer(recording, {
            alive: (pid) => {
              if (pid === -99) {
                alive.value = false;
                return true;
              }
              return alive.value;
            },
          })
        )
      )
    );
  });
});

describe("tailLog", () => {
  it.effect("returns the last lines of a log and nothing for a missing one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(`${root}/dev.log`, "one\ntwo\nthree\n");
      expect(yield* tailLog(`${root}/dev.log`, 2)).toBe("two\nthree");
      expect(yield* tailLog(`${root}/missing.log`)).toBe("");
    }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );
});

describe("ensurePortFree", () => {
  it.effect("refuses a port something already listens on", () =>
    Effect.gen(function* () {
      const error = yield* ensurePortFree(41_000).pipe(Effect.flip);
      expect(error.code).toBe("start_failed");
    }).pipe(Effect.provide(scriptedTcpProbeLayer({ isPortFree: () => Effect.succeed(false) })))
  );

  it.effect("accepts a free port", () =>
    ensurePortFree(41_000).pipe(Effect.provide(scriptedTcpProbeLayer()))
  );
});
