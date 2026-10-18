import { layerWebSocketConstructor } from "@effect/platform-bun/BunSocket";
import { Effect, FileSystem, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { PREVIEW_CDP_PORT, PREVIEW_UID, previewPaths, repoCheckout } from "#src/paths.ts";
import {
  emptyProcessGroupsRecording,
  recordingProcessGroupsLayer,
} from "#src/process-groups/test-support.ts";
import { PREVIEW_JSON } from "#src/recipe/index.ts";
import { chownRecordingServicesLayer } from "#src/sandbox/test-support.ts";
import { readPreviewStatus } from "#src/status/index.ts";
import { scriptedTcpProbeLayer } from "#src/tcp-probe/test-support.ts";
import { warmRepo } from "#src/warm/warm-repo.ts";
import { describe, expect, it } from "#src/effect-bun-test.ts";

const REPO = "acme/web";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const SERVER_PID = 802;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

const github = (url: string): Response =>
  url.endsWith(`/repos/${REPO}`)
    ? json({ default_branch: "main" })
    : url.includes("/commits/")
      ? json({ sha: HEAD })
      : url.startsWith("https://codeload.github.com/")
        ? new Response("tarball")
        : new Response("", { status: 404 });

// Port 9222 is reported taken so the browser launch and the precompile
// capture give up at once; both are best-effort in a warm-up.
const fixture = (recording = emptyProcessGroupsRecording(), serverStays = true) =>
  Layer.mergeAll(
    chownRecordingServicesLayer(),
    recordingProcessGroupsLayer(recording, {
      ownPid: 1,
      spawnedPid: SERVER_PID,
      alive: (pid) => serverStays && Math.abs(pid) === SERVER_PID,
    }),
    scriptedTcpProbeLayer({
      isPortFree: (port) => Effect.succeed(port !== PREVIEW_CDP_PORT),
      get: () => Effect.succeed({ status: 200, body: "<html>web</html>" }),
    }),
    Layer.succeed(HttpClient.HttpClient)(
      HttpClient.make((request) =>
        Effect.sync(() => HttpClientResponse.fromWeb(request, github(request.url)))
      )
    ),
    layerWebSocketConstructor
  );

const connectedRepo = (files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "ori-preview-" });
    const paths = previewPaths(`${root}/workspace`, `${root}/sandbox`);
    const checkout = repoCheckout(paths, REPO);
    yield* fs.makeDirectory(`${checkout}/.ori`, { recursive: true });
    yield* Effect.forEach(Object.entries(files), ([name, text]) =>
      fs.writeFileString(`${checkout}/${name}`, text)
    );
    return paths;
  });

const statusOf = (paths: ReturnType<typeof previewPaths>) =>
  readPreviewStatus(paths, REPO).pipe(Effect.map(Option.getOrUndefined));

const VITE_APP = { "package.json": `{"scripts":{"dev":"vite"}}` };

describe("warmRepo bringing a preview up", () => {
  it.effect("records warm with the server's port once its page answered", () =>
    Effect.gen(function* () {
      const paths = yield* connectedRepo(VITE_APP);
      yield* warmRepo(paths, REPO, {}, "request");
      const status = yield* statusOf(paths);
      expect(status?.phase).toBe("warm");
      expect(status?.headSha).toBe(HEAD);
      expect(status?.port).toBe(41_000);
      expect(status?.process?.pid).toBe(SERVER_PID);
    }).pipe(Effect.scoped, Effect.provide(fixture()))
  );

  it.effect("installs a never-installed checkout as the preview user before starting it", () => {
    const recording = emptyProcessGroupsRecording();
    return Effect.gen(function* () {
      const paths = yield* connectedRepo(VITE_APP);
      yield* warmRepo(paths, REPO, {}, "request");
      const install = recording.ran.at(-1);
      expect(install?.cwd).toBe(repoCheckout(paths, REPO));
      expect(install?.command).toContain(`--reuid=${PREVIEW_UID}`);
      expect(install?.command.at(-1)).toBe("npm install");
      expect((yield* statusOf(paths))?.installedSha).toBe(HEAD);
    }).pipe(Effect.scoped, Effect.provide(fixture(recording)));
  });

  it.effect("never records warm for a server that exited before serving", () =>
    Effect.gen(function* () {
      const paths = yield* connectedRepo(VITE_APP);
      yield* warmRepo(paths, REPO, {}, "request");
      const status = yield* statusOf(paths);
      expect(status?.phase).toBe("not_runnable");
      expect(status?.reason).toContain("The dev server exited before it started serving.");
      expect(status?.process).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(fixture(emptyProcessGroupsRecording(), false)))
  );

  it.effect("starts nothing until every variable the recipe requires is bound", () => {
    const recording = emptyProcessGroupsRecording();
    return Effect.gen(function* () {
      const paths = yield* connectedRepo({
        ...VITE_APP,
        [PREVIEW_JSON]: `{"dev":"vite --port {port}","requiredEnv":["DATABASE_URL"]}`,
      });
      yield* warmRepo(paths, REPO, {}, "request");
      const status = yield* statusOf(paths);
      expect(status?.phase).toBe("not_runnable");
      expect(status?.reason).toContain("PREVIEW_ENV_<NAME>");
      expect(recording.spawned).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(fixture(recording)));
  });
});
