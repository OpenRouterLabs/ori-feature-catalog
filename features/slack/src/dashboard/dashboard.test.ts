import { Effect } from "effect";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { StateStoreMemory, type StateStoreShape } from "#src/state/store.ts";

import { InterruptMode } from "#src/state/settings.ts";
import { UNSEEN_THREAD } from "#src/turn/listening/listen.ts";
import { dashboardResponse } from "./dashboard.ts";

const NOW = 1_700_000_000_000;

const GET = new Request("http://127.0.0.1/slack/dashboard");

const submit = (mode: string): Request =>
  new Request("http://127.0.0.1/slack/dashboard", {
    body: new URLSearchParams({ mode }),
    method: "POST",
  });

describe("the dashboard route", () => {
  test.effect("answers with a self-describing HTML page", () =>
    Effect.gen(function* () {
      const store = yield* StateStoreMemory;

      const response = yield* dashboardResponse(store, GET, NOW);

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

      const response = yield* dashboardResponse(store, GET, NOW);

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

      const body = yield* dashboardResponse(store, GET, NOW).pipe(
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
      const broken: StateStoreShape = {
        clearSession: () => Effect.void,
        getInterruptMode: () => Effect.succeed(InterruptMode.Steer),
        getListen: () => Effect.succeed(UNSEEN_THREAD),
        getSession: () => Effect.succeed(undefined),
        listThreads: () => Effect.succeed([]),
        putInterruptMode: () => Effect.void,
        putSession: () => Effect.void,
        updateListen: () => Effect.succeed(UNSEEN_THREAD),
      };

      const response = yield* dashboardResponse(broken, GET, NOW);

      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.text())).toContain(
        "No threads yet"
      );
    })
  );
});

describe("saving the setting", () => {
  test.effect("a submitted mode is stored", () =>
    Effect.gen(function* () {
      const store = yield* StateStoreMemory;

      yield* dashboardResponse(store, submit(InterruptMode.Queue), NOW);

      expect(yield* store.getInterruptMode()).toBe(InterruptMode.Queue);
    })
  );

  test.effect("it redirects back to the page rather than answering with one", () =>
    Effect.gen(function* () {
      const store = yield* StateStoreMemory;

      const response = yield* dashboardResponse(
        store,
        submit(InterruptMode.Queue),
        NOW
      );

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/slack/dashboard");
    })
  );

  test.effect("the saved mode is what the page then shows as checked", () =>
    Effect.gen(function* () {
      const store = yield* StateStoreMemory;
      yield* dashboardResponse(store, submit(InterruptMode.Queue), NOW);

      const body = yield* dashboardResponse(store, GET, NOW).pipe(
        Effect.flatMap((response) => Effect.promise(() => response.text()))
      );

      expect(body).toContain('value="queue" checked');
    })
  );

  test.effect("a junk value falls back to the default instead of failing", () =>
    Effect.gen(function* () {
      const store = yield* StateStoreMemory;
      yield* store.putInterruptMode(InterruptMode.Queue);

      yield* dashboardResponse(store, submit("nonsense"), NOW);

      expect(yield* store.getInterruptMode()).toBe(InterruptMode.Steer);
    })
  );

  test.effect("a body that will not parse still redirects", () =>
    Effect.gen(function* () {
      const store = yield* StateStoreMemory;
      const malformed = new Request("http://127.0.0.1/slack/dashboard", {
        body: "%%%",
        headers: { "content-type": "multipart/form-data; boundary=nope" },
        method: "POST",
      });

      const response = yield* dashboardResponse(store, malformed, NOW);

      expect(response.status).toBe(303);
    })
  );
});
