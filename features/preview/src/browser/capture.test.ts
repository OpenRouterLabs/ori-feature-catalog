import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { layerWebSocketConstructor } from "@effect/platform-bun/BunSocket";
import { afterAll, beforeAll } from "bun:test";
import { Effect, FileSystem, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { capturePage, ensureBrowser } from "./index.ts";
import { previewPaths } from "../paths.ts";
import {
  emptyProcessGroupsRecording,
  recordingProcessGroupsLayer,
} from "../process-groups/test-support.ts";
import { scriptedTcpProbeLayer } from "../tcp-probe/test-support.ts";
import { describe, expect, it } from "../effect-bun-test.ts";

const PNG_BYTES = new Uint8Array([137, 80, 78, 71]);
const PAGE_URL = "http://127.0.0.1:41000/";

interface Page {
  href: string;
  screenshot: unknown;
  rejects?: string;
}

const page: Page = { href: PAGE_URL, screenshot: { data: Buffer.from(PNG_BYTES).toString("base64") } };

const resultFor = (method: string, params: Record<string, unknown>): unknown => {
  if (method === "Runtime.evaluate") {
    return params.expression === "document.title"
      ? { result: { value: "Acme" } }
      : { result: { value: [page.href, "complete"] } };
  }
  return method === "Page.captureScreenshot" ? page.screenshot : {};
};

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request, bun) => (bun.upgrade(request, { data: undefined }) ? undefined : new Response("upgrade required", { status: 426 })),
    websocket: {
      message: (socket, raw) => {
        const call = JSON.parse(String(raw)) as { id: number; method: string; params: Record<string, unknown> };
        if (call.method === "Page.navigate") {
          socket.send(JSON.stringify({ method: "Runtime.consoleAPICalled", params: { type: "error", args: [{ value: "boom" }] } }));
        }
        socket.send(
          JSON.stringify(
            page.rejects === call.method
              ? { id: call.id, error: { message: "Target closed" } }
              : { id: call.id, result: resultFor(call.method, call.params) }
          )
        );
      },
    },
  });
});

afterAll(() => {
  server.stop(true);
});

const debugEndpoints = (requested: string[]) =>
  Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request) =>
      Effect.sync(() => {
        requested.push(`${request.method} ${new URL(request.url).pathname}`);
        const tab = { id: "TAB1", type: "page", url: "about:blank", webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/page/TAB1` };
        const body = request.url.includes("/json/new") ? tab : request.url.includes("/json/list") ? [tab] : "closing";
        return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body)));
      })
    )
  );

const fixture = (requested: string[], recording = emptyProcessGroupsRecording()) =>
  Layer.mergeAll(
    BunServicesLayer,
    layerWebSocketConstructor,
    debugEndpoints(requested),
    recordingProcessGroupsLayer(recording, { ownPid: 1, alive: (pid) => pid === 901 }),
    scriptedTcpProbeLayer()
  );

const reset = (next: Partial<Page>) =>
  Effect.sync(() => {
    page.href = PAGE_URL;
    page.screenshot = { data: Buffer.from(PNG_BYTES).toString("base64") };
    page.rejects = undefined;
    Object.assign(page, next);
  });

describe("capturePage", () => {
  it.effect("screenshots the page in a fresh tab, with its title and console errors, then closes the tab", () => {
    const requested: string[] = [];
    return Effect.gen(function* () {
      yield* reset({});
      const capture = yield* capturePage(PAGE_URL, { fullPage: true });
      expect(capture.png).toEqual(PNG_BYTES);
      expect(capture.title).toBe("Acme");
      expect(capture.consoleErrors).toEqual(["boom"]);
      expect(requested).toEqual(["PUT /json/new", "GET /json/close/TAB1"]);
    }).pipe(Effect.provide(fixture(requested)));
  });

  it.effect("refuses to capture a page that redirected to another origin", () =>
    Effect.gen(function* () {
      yield* reset({ href: "https://evil.example/login" });
      const error = yield* capturePage(PAGE_URL, { fullPage: false }).pipe(Effect.flip);
      expect(error.code).toBe("capture_failed");
      expect(error.detail).toContain("redirected away from the preview");
    }).pipe(Effect.provide(fixture([])))
  );

  it.effect("fails when the browser returns no screenshot", () =>
    Effect.gen(function* () {
      yield* reset({ screenshot: {} });
      const error = yield* capturePage(PAGE_URL, { fullPage: false }).pipe(Effect.flip);
      expect(error.detail).toBe("The preview browser returned no screenshot.");
    }).pipe(Effect.provide(fixture([])))
  );

  it.effect("fails when the browser returns an unreadable screenshot", () =>
    Effect.gen(function* () {
      yield* reset({ screenshot: { data: "%%%not-base64%%%" } });
      const error = yield* capturePage(PAGE_URL, { fullPage: false }).pipe(Effect.flip);
      expect(error.detail).toBe("The preview browser returned an unreadable screenshot.");
    }).pipe(Effect.provide(fixture([])))
  );

  it.effect("names the call the browser rejected", () =>
    Effect.gen(function* () {
      yield* reset({ rejects: "Page.enable" });
      const error = yield* capturePage(PAGE_URL, { fullPage: false }).pipe(Effect.flip);
      expect(error.code).toBe("browser_unavailable");
      expect(error.detail).toBe("The preview browser rejected Page.enable: Target closed");
    }).pipe(Effect.provide(fixture([])))
  );
});

describe("ensureBrowser", () => {
  it.effect("leaves the preview's own running browser alone", () => {
    const recording = emptyProcessGroupsRecording();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = previewPaths(yield* fs.makeTempDirectoryScoped());
      yield* fs.makeDirectory(paths.root, { recursive: true });
      yield* fs.writeFileString(paths.browserState, JSON.stringify({ pid: 901 }));
      yield* ensureBrowser(paths, {});
      expect(recording.spawned).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(fixture([], recording)));
  });
});
