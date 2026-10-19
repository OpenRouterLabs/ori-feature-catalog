import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Layer } from "effect";

import type { DirectResponse } from "../readiness/direct-get.ts";

import {
  emptyProcessGroupsRecording,
  recordingProcessGroupsLayer,
} from "../process-groups/test-support.ts";
import { scriptedTcpProbeLayer } from "../tcp-probe/test-support.ts";
import { runInstall, startServer } from "./start-server.ts";
import { PreviewError } from "../errors.ts";
import { describe, expect, it } from "../effect-bun-test.ts";

const SERVER_PID = 701;
const PORT = 41_000;

const fixture = (input: {
  readonly recording?: ReturnType<typeof emptyProcessGroupsRecording>;
  readonly exitCode?: number;
  readonly portFree?: boolean;
  readonly answer?: DirectResponse;
  readonly serverAlive?: boolean;
}) =>
  Layer.mergeAll(
    BunServicesLayer,
    recordingProcessGroupsLayer(input.recording, {
      ownPid: 1,
      spawnedPid: SERVER_PID,
      exitCode: input.exitCode,
      alive: (pid) => (input.serverAlive ?? true) && pid === SERVER_PID,
    }),
    scriptedTcpProbeLayer({
      isPortFree: () => Effect.succeed(input.portFree ?? true),
      ...(input.answer === undefined ? {} : { get: () => Effect.succeed(input.answer as DirectResponse) }),
    })
  );

const scratch = FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.makeTempDirectoryScoped()));

const installInput = (root: string, install: string | undefined) => ({
  recipe: install === undefined ? { dev: "bun dev" } : { dev: "bun dev", install },
  checkout: root,
  env: {},
  home: `${root}/home`,
  port: PORT,
  logPath: `${root}/logs/install.log`,
});

const asPreviewError = (error: unknown): Effect.Effect<PreviewError> =>
  error instanceof PreviewError ? Effect.succeed(error) : Effect.die(error);

describe("runInstall", () => {
  it.effect("does nothing for a recipe without an install step", () => {
    const recording = emptyProcessGroupsRecording();
    return Effect.gen(function* () {
      yield* runInstall(installInput(yield* scratch, undefined));
      expect(recording.ran).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(fixture({ recording })));
  });

  it.effect("runs the install in the sandbox with the port filled in", () => {
    const recording = emptyProcessGroupsRecording();
    return Effect.gen(function* () {
      yield* runInstall(installInput(yield* scratch, "bun install --port {port}"));
      expect(recording.ran[0]?.command.at(-1)).toBe(`bun install --port ${PORT}`);
      expect(recording.ran[0]?.env.PORT).toBe(String(PORT));
    }).pipe(Effect.scoped, Effect.provide(fixture({ recording })));
  });

  it.effect("fails with the install log's tail when the install exits non-zero", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* scratch;
      yield* fs.makeDirectory(`${root}/logs`, { recursive: true });
      yield* fs.writeFileString(`${root}/logs/install.log`, "lockfile out of date\n");
      const error = yield* runInstall(installInput(root, "bun install")).pipe(Effect.flip, Effect.flatMap(asPreviewError));
      expect(error.code).toBe("install_failed");
      expect(error.detail).toContain("exited 1");
      expect(error.detail).toContain("lockfile out of date");
    }).pipe(Effect.scoped, Effect.provide(fixture({ exitCode: 1 })))
  );
});

const serverInput = (root: string) => ({
  recipe: { dev: "bun dev --port {port}", readyPath: "health" },
  directory: root,
  env: {},
  home: `${root}/home`,
  port: PORT,
  logPath: `${root}/dev.log`,
});

describe("startServer", () => {
  it.effect("refuses a port something already listens on before spawning anything", () => {
    const recording = emptyProcessGroupsRecording();
    return Effect.gen(function* () {
      const error = yield* startServer(serverInput(yield* scratch)).pipe(Effect.flip, Effect.flatMap(asPreviewError));
      expect(error.code).toBe("start_failed");
      expect(recording.spawned).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(fixture({ recording, portFree: false })));
  });

  it.effect("returns the server once its ready path answers", () => {
    const recording = emptyProcessGroupsRecording();
    return Effect.gen(function* () {
      const server = yield* startServer(serverInput(yield* scratch));
      expect(server.process.pid).toBe(SERVER_PID);
      expect(server.url.startsWith(`http://127.0.0.1:${PORT}`)).toBe(true);
      expect(recording.spawned[0]?.command.at(-1)).toBe(`bun dev --port ${PORT}`);
    }).pipe(
      Effect.scoped,
      Effect.provide(fixture({ recording, answer: { status: 200, body: "<html>ok</html>" } }))
    );
  });

  it.effect("fails with the dev log's tail when the server exits before serving", () =>
    Effect.gen(function* () {
      const error = yield* startServer(serverInput(yield* scratch)).pipe(Effect.flip, Effect.flatMap(asPreviewError));
      expect(error.code).toBe("start_failed");
      expect(error.detail).toContain("exited before it started serving");
    }).pipe(Effect.scoped, Effect.provide(fixture({ serverAlive: false })))
  );
});
