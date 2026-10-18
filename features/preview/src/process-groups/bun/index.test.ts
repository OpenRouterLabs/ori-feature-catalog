import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { Effect, Fiber, FileSystem, Layer, Schedule } from "effect";

import { bunProcessGroupsLayer } from "#src/process-groups/bun/index.ts";
import {
  type DetachedSpawn,
  ProcessGroups,
} from "#src/process-groups/index.ts";
import { killGroup } from "#src/process/index.ts";
import { bunTcpProbeLayer } from "#src/tcp-probe/bun/index.ts";
import { TcpProbe } from "#src/tcp-probe/index.ts";
import { encodeUnknownJson } from "#src/json.ts";
import { describe, expect, it } from "#src/effect-bun-test.ts";

const SERVER_SCRIPT = `const server=Bun.serve({hostname:"127.0.0.1",port:0,idleTimeout:0,fetch:()=>new Response("ready from the group")});console.log("port="+server.port);`;

const GROUP_SCRIPT = `Bun.spawn([process.execPath,"-e",${encodeUnknownJson(SERVER_SCRIPT)}],{stdout:"inherit",stderr:"inherit"});setInterval(()=>undefined,1000);`;

const PORT_LINE = /port=(\d+)/u;

const POLL = Schedule.spaced("50 millis");

const adaptersLayer = Layer.mergeAll(
  bunProcessGroupsLayer,
  bunTcpProbeLayer,
  BunServicesLayer
);

const bunScript = (root: string, script: string): DetachedSpawn => ({
  command: [globalThis.process.execPath, "-e", script],
  cwd: root,
  env: {},
  logPath: `${root}/child.log`,
});

const announcedPort = Effect.fnUntraced(function* (logPath: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(logPath).pipe(
    Effect.orElseSucceed(() => ""),
    Effect.flatMap((text) => Effect.fromNullishOr(PORT_LINE.exec(text)?.[1])),
    Effect.map(Number),
    Effect.retry({ schedule: POLL, times: 200 })
  );
});

const portFreed = (port: number) =>
  TcpProbe.use((probe) => probe.isPortFree(port)).pipe(
    Effect.repeat({ schedule: POLL, until: (free) => free, times: 200 })
  );

describe("bunProcessGroupsLayer with bunTcpProbeLayer", () => {
  it.live(
    "spawns a detached group whose grandchild serves, probes and GETs its port, and killGroup takes the whole group down",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const groups = yield* ProcessGroups;
        const probe = yield* TcpProbe;
        const root = yield* fs.makeTempDirectoryScoped();
        const spawn = bunScript(root, GROUP_SCRIPT);
        const pid = yield* groups.spawnDetached(spawn);
        yield* Effect.addFinalizer(() => groups.signal(-pid, "SIGKILL"));
        const port = yield* announcedPort(spawn.logPath);
        expect(yield* probe.isPortFree(port)).toBe(false);
        const response = yield* probe.get(`http://127.0.0.1:${port}/`);
        expect(response.status).toBe(200);
        expect(response.body).toContain("ready from the group");
        expect(yield* groups.signal(pid, 0)).toBe(true);
        yield* killGroup({ pid });
        expect(yield* portFreed(port)).toBe(true);
        const refused = yield* probe
          .get(`http://127.0.0.1:${port}/`)
          .pipe(Effect.flip);
        expect(refused.detail).toContain("nothing listening");
      }).pipe(Effect.scoped, Effect.provide(adaptersLayer))
  );

  it.live("runs a command to exit and returns its exit code", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const groups = yield* ProcessGroups;
      const root = yield* fs.makeTempDirectoryScoped();
      expect(yield* groups.runToExit(bunScript(root, "process.exit(3)"))).toBe(
        3
      );
    }).pipe(Effect.scoped, Effect.provide(adaptersLayer))
  );

  it.live(
    "kills the whole group when the run is interrupted, so a cancelled install leaves nothing listening",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const groups = yield* ProcessGroups;
        const root = yield* fs.makeTempDirectoryScoped();
        const spawn = bunScript(root, GROUP_SCRIPT);
        const run = yield* Effect.forkChild(groups.runToExit(spawn));
        const port = yield* announcedPort(spawn.logPath);
        yield* Fiber.interrupt(run);
        expect(yield* portFreed(port)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(adaptersLayer))
  );

  it.live("reports its own pid, which isAlive refuses to signal", () =>
    Effect.gen(function* () {
      const groups = yield* ProcessGroups;
      expect(yield* groups.ownPid).toBe(globalThis.process.pid);
    }).pipe(Effect.provide(adaptersLayer))
  );
});
