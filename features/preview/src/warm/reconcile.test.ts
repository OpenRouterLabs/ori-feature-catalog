import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { layerWebSocketConstructor } from "@effect/platform-bun/BunSocket";
import { Effect, FileSystem, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { previewPaths, PREVIEW_REPOS_ENV } from "../paths.ts";
import {
  emptyProcessGroupsRecording,
  recordingProcessGroupsLayer,
} from "../process-groups/test-support.ts";
import { readPreviewStatus, writePreviewStatus } from "../status/index.ts";
import { scriptedTcpProbeLayer } from "../tcp-probe/test-support.ts";
import { connectedRepos, reconcilePreviews } from "./index.ts";
import { describe, expect, it } from "../effect-bun-test.ts";

const githubRefusing = (requested: string[] = []) =>
  Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request) =>
      Effect.sync(() => {
        requested.push(request.url);
        return HttpClientResponse.fromWeb(request, new Response("", { status: 404 }));
      })
    )
  );

const fixture = (requested?: string[]) =>
  Layer.mergeAll(
    BunServicesLayer,
    layerWebSocketConstructor,
    githubRefusing(requested),
    recordingProcessGroupsLayer(emptyProcessGroupsRecording(), { ownPid: 1, alive: () => false }),
    scriptedTcpProbeLayer()
  );

describe("connectedRepos", () => {
  it.effect("asks GitHub's installation listing when no repositories are configured", () => {
    const requested: string[] = [];
    return Effect.gen(function* () {
      expect(yield* connectedRepos({})).toEqual([]);
      expect(requested[0]).toStartWith("https://api.github.com/installation/repositories");
    }).pipe(Effect.provide(fixture(requested)));
  });
});

describe("reconcilePreviews", () => {
  it.effect("warms each configured repository and parks previews outside the warm set", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = previewPaths(yield* fs.makeTempDirectoryScoped());
      yield* writePreviewStatus(paths, { repo: "acme/old", phase: "warm", process: { pid: 77 }, port: 41_005 });
      const reconciled = yield* reconcilePreviews(paths, { [PREVIEW_REPOS_ENV]: "acme/web" });
      expect(reconciled).toBe(1);
      const web = Option.getOrUndefined(yield* readPreviewStatus(paths, "acme/web"));
      expect(web?.phase).toBe("not_runnable");
      const old = Option.getOrUndefined(yield* readPreviewStatus(paths, "acme/old"));
      expect(old?.phase).not.toBe("warm");
    }).pipe(Effect.scoped, Effect.provide(fixture()))
  );
});
