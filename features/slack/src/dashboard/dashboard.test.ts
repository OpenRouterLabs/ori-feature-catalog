/**
 * dashboard.test.ts — the route around the page.
 *
 * The rendering is pinned in page.test.ts. What is left here is the HTTP
 * envelope and the one behaviour that matters when things are going wrong: a
 * store that cannot answer must still produce a page.
 */

import { Effect } from "effect";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import type { StateStoreShape } from "../state/store.ts";

import { StateStoreMemory } from "../state/store.ts";
import { UNSEEN_THREAD } from "../turn/listen.ts";
import { dashboardResponse } from "./dashboard.ts";

const NOW = 1_700_000_000_000;

describe("the dashboard route", () => {
  test.effect("answers with a self-describing HTML page", () =>
    Effect.gen(function* () {
      const store = yield* StateStoreMemory;

      const response = yield* dashboardResponse(store, NOW);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(yield* Effect.promise(() => response.text())).toContain(
        "<!DOCTYPE html>"
      );
    })
  );

  test.effect("forbids caching, because the page is live state", () =>
    Effect.gen(function* () {
      const store = yield* StateStoreMemory;

      const response = yield* dashboardResponse(store, NOW);

      expect(response.headers.get("cache-control")).toBe("no-store");
    })
  );

  test.effect("renders what the store holds", () =>
    Effect.gen(function* () {
      const store = yield* StateStoreMemory;
      yield* store.putSession("C9:1.1", {
        sessionId: "sess-live",
        startedAt: NOW,
      });

      const body = yield* dashboardResponse(store, NOW).pipe(
        Effect.flatMap((response) =>
          Effect.promise(() => response.text())
        )
      );

      expect(body).toContain("C9:1.1");
      expect(body).toContain("sess-live");
    })
  );

  test.effect("still serves a page when the store cannot answer", () =>
    Effect.gen(function* () {
      // The durable store swallows its own failures and answers with an empty
      // list, so this is the shape a real outage takes. An operator opening a
      // dashboard mid-incident should get an empty table, not a stack trace.
      const broken: StateStoreShape = {
        clearSession: () => Effect.void,
        getListen: () => Effect.succeed(UNSEEN_THREAD),
        getSession: () => Effect.succeed(undefined),
        listThreads: () => Effect.succeed([]),
        putSession: () => Effect.void,
        updateListen: () => Effect.succeed(UNSEEN_THREAD),
      };

      const response = yield* dashboardResponse(broken, NOW);

      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.text())).toContain(
        "No threads yet"
      );
    })
  );
});
