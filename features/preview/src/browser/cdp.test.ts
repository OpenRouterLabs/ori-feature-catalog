import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { closeTarget, createTarget, listTargets } from "#src/browser/cdp.ts";
import { describe, expect, it } from "#src/effect-bun-test.ts";

const tab = {
  id: "TAB1",
  type: "page",
  url: "http://127.0.0.1:41000/",
  webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/TAB1",
};

const browserAnswering = (body: unknown, requested: string[] = []) =>
  Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request) =>
      Effect.sync(() => {
        requested.push(`${request.method} ${request.url}`);
        return HttpClientResponse.fromWeb(
          request,
          new Response(typeof body === "string" ? body : JSON.stringify(body))
        );
      })
    )
  );

describe("the preview browser's debug endpoints", () => {
  it.effect("lists the open tabs on the local debug port", () => {
    const requested: string[] = [];
    return Effect.gen(function* () {
      expect(yield* listTargets()).toEqual([tab]);
      expect(requested).toEqual(["GET http://127.0.0.1:9222/json/list"]);
    }).pipe(Effect.provide(browserAnswering([tab], requested)));
  });

  it.effect("calls a malformed target list unavailable rather than guessing", () =>
    Effect.gen(function* () {
      const error = yield* listTargets().pipe(Effect.flip);
      expect(error.code).toBe("browser_unavailable");
      expect(error.detail).toContain("malformed target list");
    }).pipe(Effect.provide(browserAnswering([{ id: 1 }])))
  );

  it.effect("calls an unreadable target list unavailable", () =>
    Effect.gen(function* () {
      const error = yield* listTargets().pipe(Effect.flip);
      expect(error.detail).toContain("no target list");
    }).pipe(Effect.provide(browserAnswering("not json")))
  );

  it.effect("opens a tab on the url it was given", () => {
    const requested: string[] = [];
    return Effect.gen(function* () {
      expect(yield* createTarget(tab.url)).toEqual(tab);
      expect(requested).toEqual([
        `PUT http://127.0.0.1:9222/json/new?${encodeURIComponent(tab.url)}`,
      ]);
    }).pipe(Effect.provide(browserAnswering(tab, requested)));
  });

  it.effect("calls a malformed new tab unavailable", () =>
    Effect.gen(function* () {
      const error = yield* createTarget(tab.url).pipe(Effect.flip);
      expect(error.detail).toContain("malformed tab");
    }).pipe(Effect.provide(browserAnswering({ id: "TAB1" })))
  );

  it.effect("closes a tab by id", () => {
    const requested: string[] = [];
    return closeTarget("TAB1").pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(requested).toEqual(["GET http://127.0.0.1:9222/json/close/TAB1"]);
        })
      ),
      Effect.provide(browserAnswering("Target is closing", requested))
    );
  });
});
