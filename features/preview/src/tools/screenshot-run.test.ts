import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { layerWebSocketConstructor } from "@effect/platform-bun/BunSocket";
import { afterAll, beforeAll } from "bun:test";
import { Effect, FileSystem, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import type { ScreenshotArgs } from "./screenshot.ts";

import { scriptedDaemonCredentialsLayer } from "../daemon-credentials/test-support.ts";
import { previewPaths } from "../paths.ts";
import {
  emptyProcessGroupsRecording,
  recordingProcessGroupsLayer,
} from "../process-groups/test-support.ts";
import { writePreviewStatus } from "../status/index.ts";
import { scriptedTcpProbeLayer } from "../tcp-probe/test-support.ts";
import { runPreviewScreenshot } from "./screenshot.ts";
import { describe, expect, it } from "../effect-bun-test.ts";

const REPO = "acme/web";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const SERVING_PID = 501;
const PAGE_URL = "http://127.0.0.1:41000/";
const PNG_BYTES = new Uint8Array([137, 80, 78, 71]);

let server: ReturnType<typeof Bun.serve>;

const cdpResult = (method: string, params: Record<string, unknown>): unknown => {
  if (method === "Runtime.evaluate") {
    return params.expression === "document.title"
      ? { result: { value: "Acme dashboard" } }
      : { result: { value: [PAGE_URL, "complete"] } };
  }
  return method === "Page.captureScreenshot"
    ? { data: Buffer.from(PNG_BYTES).toString("base64") }
    : {};
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request, bun) => (bun.upgrade(request, { data: undefined }) ? undefined : new Response("", { status: 426 })),
    websocket: {
      message: (socket, raw) => {
        const call = JSON.parse(String(raw)) as { id: number; method: string; params: Record<string, unknown> };
        if (call.method === "Page.navigate") {
          socket.send(JSON.stringify({ method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: user is undefined\n    at render (app.js:1:1)" } } } }));
        }
        socket.send(JSON.stringify({ id: call.id, result: cdpResult(call.method, call.params) }));
      },
    },
  });
});

afterAll(() => {
  server.stop(true);
});

const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const route = (url: string): Response => {
  const tab = { id: "TAB1", type: "page", url: "about:blank", webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/page/TAB1` };
  if (url.includes("/json/list")) return json([tab]);
  if (url.includes("/json/new")) return json(tab);
  if (url.includes("/json/close")) return new Response("closing");
  if (url.endsWith(`/repos/${REPO}`)) return json({ default_branch: "main" });
  if (url.includes("/commits/")) return json({ sha: HEAD });
  return new Response("gone", { status: 404 });
};

const fixture = Layer.mergeAll(
  BunServicesLayer,
  layerWebSocketConstructor,
  scriptedDaemonCredentialsLayer,
  scriptedTcpProbeLayer(),
  recordingProcessGroupsLayer(emptyProcessGroupsRecording(), { ownPid: 1, alive: (pid) => pid === SERVING_PID }),
  Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request) => Effect.sync(() => HttpClientResponse.fromWeb(request, route(request.url))))
  )
);

const servingRoot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const paths = previewPaths(root);
  yield* writePreviewStatus(paths, {
    repo: REPO,
    phase: "warm",
    process: { pid: SERVING_PID },
    port: 41_000,
    url: PAGE_URL,
    headSha: HEAD,
  });
  yield* fs.writeFileString(paths.browserState, JSON.stringify({ pid: SERVING_PID }));
  return root;
});

const contextAt = (root: string, args: ScreenshotArgs) => ({
  args,
  paths: previewPaths(root),
  env: {},
  turnEnv: {},
  workspaceRoot: root,
});

describe("preview-screenshot on a warm preview", () => {
  it.effect("saves the screenshot in the workspace and returns it with the page title", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* servingRoot;
      const result = yield* runPreviewScreenshot(contextAt(root, { repo: REPO, path: "settings" }));
      const [text, image] = result.content;
      expect(text?.type === "text" && text.text).toContain("current screenshot (saved as preview-shots/acme__web-");
      expect(text?.type === "text" && text.text).toContain("Acme dashboard");
      expect(text?.type === "text" && text.text).toContain("The page logged console errors:");
      expect(text?.type === "text" && text.text).toContain("TypeError: user is undefined");
      expect(text?.type === "text" && text.text).not.toContain("at render");
      expect(image).toEqual({ type: "image", mimeType: "image/png", data: Buffer.from(PNG_BYTES).toString("base64") });
      const saved = yield* fs.readDirectory(previewPaths(root).shots);
      expect(saved).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(fixture))
  );

  it.effect("in a Slack turn, says how many screenshots reached the thread", () =>
    Effect.gen(function* () {
      const root = yield* servingRoot;
      const result = yield* runPreviewScreenshot({
        ...contextAt(root, { repo: REPO }),
        env: { ORI_DAEMON_TOKEN: "daemon-token" },
        turnEnv: { SLACK_CHANNEL_ID: "C123", SLACK_THREAD_TS: "1792258678.806579" },
      });
      const last = result.content.at(-1);
      expect(result.content).toHaveLength(3);
      expect(last?.type === "text" && last.text).toContain("Slack thread");
    }).pipe(Effect.scoped, Effect.provide(fixture))
  );
});
