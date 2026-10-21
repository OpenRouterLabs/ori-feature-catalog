import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { layerWebSocketConstructor } from "@effect/platform-bun/BunSocket";
import { DateTime, Effect, FileSystem, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import type { PreviewStatus } from "#src/schemas.ts";

import { scriptedDaemonCredentialsLayer } from "#src/daemon-credentials/test-support.ts";
import { previewPaths } from "#src/paths.ts";
import {
  emptyProcessGroupsRecording,
  recordingProcessGroupsLayer,
} from "#src/process-groups/test-support.ts";
import { readPreviewStatus, writePreviewStatus } from "#src/status/index.ts";
import { scriptedTcpProbeLayer } from "#src/tcp-probe/test-support.ts";
import { runPreviewSaveRecipe } from "#src/tools/save-recipe.ts";
import { runPreviewScreenshot } from "#src/tools/screenshot.ts";
import { runPreviewWarm } from "#src/tools/warm.ts";
import { warmRepo } from "#src/warm/warm-repo.ts";
import { describe, expect, it } from "#src/effect-bun-test.ts";

const REPO = "acme/web";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const SERVING_PID = 501;

type Route = (url: string) => Response;

const githubLayer = (route: Route, requested: string[] = []) =>
  Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request) =>
      Effect.sync(() => {
        requested.push(request.url);
        return HttpClientResponse.fromWeb(request, route(request.url));
      })
    )
  );

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

const githubAt = (sha: string): Route => (url) =>
  url.endsWith(`/repos/${REPO}`)
    ? json({ default_branch: "main" })
    : url.includes("/commits/")
      ? json({ sha })
      : new Response("gone", { status: 404 });

const answering = (status: number, headers: Record<string, string> = {}): Route => () =>
  new Response("", { status, headers });

const fixture = (route: Route, requested?: string[]) =>
  Layer.mergeAll(
    BunServicesLayer,
    githubLayer(route, requested),
    recordingProcessGroupsLayer(emptyProcessGroupsRecording(), {
      ownPid: 1,
      alive: (pid) => pid === SERVING_PID,
    }),
    scriptedTcpProbeLayer(),
    layerWebSocketConstructor,
    scriptedDaemonCredentialsLayer
  );

const statusOf = (root: string) =>
  readPreviewStatus(previewPaths(root), REPO).pipe(Effect.map(Option.getOrUndefined));

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const seed = Effect.fn(function* (
  root: string,
  status: Omit<PreviewStatus, "updatedAt" | "repo">
) {
  yield* writePreviewStatus(previewPaths(root), { repo: REPO, ...status });
});

const tempRoot = FileSystem.FileSystem.pipe(
  Effect.flatMap((fs) => fs.makeTempDirectoryScoped())
);

describe("warmRepo", () => {
  it.effect("records a repository GitHub does not grant as not runnable, with the reason", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      yield* warmRepo(previewPaths(root), REPO, {}, "request");
      const status = yield* statusOf(root);
      expect(status?.phase).toBe("not_runnable");
      expect(status?.reason).toContain("GitHub answered 404");
    }).pipe(Effect.scoped, Effect.provide(fixture(answering(404))))
  );

  it.effect("keeps serving a warm preview through a GitHub rate limit", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      yield* seed(root, { phase: "warm", process: { pid: SERVING_PID }, port: 41_000 });
      yield* warmRepo(previewPaths(root), REPO, {}, "request");
      expect((yield* statusOf(root))?.phase).toBe("warm");
    }).pipe(
      Effect.scoped,
      Effect.provide(fixture(answering(403, { "x-ratelimit-remaining": "0" })))
    )
  );

  it.effect("stops serving when GitHub reports the outage on a preview that is not running", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      yield* seed(root, { phase: "warm", process: { pid: 999 }, port: 41_000 });
      yield* warmRepo(previewPaths(root), REPO, {}, "request");
      const status = yield* statusOf(root);
      expect(status?.phase).toBe("not_runnable");
      expect(status?.reason).toContain("GitHub answered 503");
    }).pipe(Effect.scoped, Effect.provide(fixture(answering(503))))
  );

  it.effect("leaves a preview already serving the default branch head alone", () => {
    const requested: string[] = [];
    return Effect.gen(function* () {
      const root = yield* tempRoot;
      yield* seed(root, { phase: "warm", process: { pid: SERVING_PID }, headSha: HEAD });
      yield* warmRepo(previewPaths(root), REPO, {}, "request");
      expect((yield* statusOf(root))?.phase).toBe("warm");
      expect(requested).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(fixture(githubAt(HEAD), requested)));
  });

  it.effect("lets a sweep reuse a head checked a moment ago instead of asking GitHub", () => {
    const requested: string[] = [];
    return Effect.gen(function* () {
      const root = yield* tempRoot;
      yield* seed(root, {
        phase: "warm",
        process: { pid: SERVING_PID },
        headSha: HEAD,
        headCheckedAt: yield* nowIso,
      });
      yield* warmRepo(previewPaths(root), REPO, {}, "sweep");
      expect(requested).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(fixture(githubAt(HEAD), requested)));
  });

  it.effect("holds a sweep off a head that just failed", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      yield* seed(root, { phase: "not_runnable", headSha: HEAD, reason: "install failed" });
      yield* warmRepo(previewPaths(root), REPO, {}, "sweep");
      expect((yield* statusOf(root))?.reason).toBe("install failed");
    }).pipe(Effect.scoped, Effect.provide(fixture(githubAt(HEAD))))
  );

  it.effect("records the new head when bringing it up fails", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      yield* warmRepo(previewPaths(root), REPO, {}, "request");
      const status = yield* statusOf(root);
      expect(status?.phase).toBe("not_runnable");
      expect(status?.headSha).toBe(HEAD);
    }).pipe(Effect.scoped, Effect.provide(fixture(githubAt(HEAD))))
  );
});

const toolContext = <Args>(root: string, args: Args) => ({
  args,
  paths: previewPaths(root),
  env: {},
  turnEnv: {},
  workspaceRoot: root,
});

const textOf = (result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }) =>
  result.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");

describe("preview-warm", () => {
  it.effect("tells the agent why a repository is not runnable and how to fix it", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      const result = yield* runPreviewWarm(toolContext(root, { repo: "Acme/Web" }));
      expect(textOf(result)).toContain("acme/web is not runnable");
      expect(textOf(result)).toContain("preview-save-recipe");
    }).pipe(Effect.scoped, Effect.provide(fixture(answering(404))))
  );

  it.effect("tells the agent a running preview is ready to screenshot", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      yield* seed(root, { phase: "warm", process: { pid: SERVING_PID }, headSha: HEAD });
      const result = yield* runPreviewWarm(toolContext(root, { repo: REPO }));
      expect(textOf(result)).toBe(`${REPO} is running. Call preview-screenshot to see it.`);
    }).pipe(Effect.scoped, Effect.provide(fixture(githubAt(HEAD))))
  );
});

describe("preview-save-recipe", () => {
  it.effect("caches the recipe, rewarms the repository and offers the recipe as a pull request", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* tempRoot;
      const result = yield* runPreviewSaveRecipe(
        toolContext(root, { repo: "Acme/Web", dev: "bun run dev --port {port}" })
      );
      const text = textOf(result);
      expect(text).toContain("Saved the recipe for acme/web.");
      expect(text).toContain("acme/web is not runnable");
      expect(text).toContain('"dev": "bun run dev --port {port}"');
      const cached = yield* fs.readFileString(`${previewPaths(root).recipes}/acme__web.json`);
      expect(cached).toContain("bun run dev --port {port}");
    }).pipe(Effect.scoped, Effect.provide(fixture(answering(404))))
  );
});

describe("preview-screenshot", () => {
  it.effect("refuses to screenshot a repository that is not warm and says why", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      const error = yield* runPreviewScreenshot(toolContext(root, { repo: REPO })).pipe(Effect.flip);
      expect(error._tag).toBe("PreviewError");
      expect(error.message).toContain(`${REPO} is not warm`);
      expect(error.message).toContain("GitHub answered 404");
    }).pipe(Effect.scoped, Effect.provide(fixture(answering(404))))
  );
});
