/* oxlint-disable typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/max-lines-per-function eslint/require-await eslint/no-unsafe-optional-chaining typescript/no-invalid-void-type promise/avoid-new promise/param-names unicorn/consistent-function-scoping -- test doubles assert on recorded `unknown` args and stand in for Slack SDK shapes; cases read better whole than split */
import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { Effect } from "effect";

import { StateStoreMemory } from "./store.ts";

describe("StateStoreMemory", () => {
  test.effect("returns undefined for an unknown thread", () =>
    Effect.gen(function* () {
      const state = yield* StateStoreMemory;

      expect(yield* state.getSession("slack:T1:C1:1.1")).toBeUndefined();
    })
  );

  test.effect("round-trips a session", () =>
    Effect.gen(function* () {
      const state = yield* StateStoreMemory;
      const session = {
        sessionId: "sess-1",
        startedAt: 1_700_000_000_000,
      };

      yield* state.putSession("thread-a", session);

      expect(yield* state.getSession("thread-a")).toEqual(session);
    })
  );

  test.effect("keeps threads independent", () =>
    Effect.gen(function* () {
      // A shared entry would let two conversations resume each other's session.
      const state = yield* StateStoreMemory;

      yield* state.putSession("thread-a", {
        sessionId: "a",
        startedAt: 1,
      });
      yield* state.putSession("thread-b", {
        sessionId: "b",
        startedAt: 2,
      });

      expect(yield* state.getSession("thread-a")).toMatchObject({
        sessionId: "a",
      });
      expect(yield* state.getSession("thread-b")).toMatchObject({
        sessionId: "b",
      });
    })
  );

  test.effect("a later put replaces the earlier session", () =>
    Effect.gen(function* () {
      const state = yield* StateStoreMemory;

      yield* state.putSession("thread-a", {
        sessionId: "old",
        startedAt: 1,
      });
      yield* state.putSession("thread-a", {
        sessionId: "new",
        startedAt: 2,
      });

      expect(yield* state.getSession("thread-a")).toMatchObject({
        sessionId: "new",
      });
    })
  );

  test.effect("clearSession forgets the thread", () =>
    Effect.gen(function* () {
      const state = yield* StateStoreMemory;

      yield* state.putSession("thread-a", {
        sessionId: "a",
        startedAt: 1,
      });
      yield* state.clearSession("thread-a");

      expect(yield* state.getSession("thread-a")).toBeUndefined();
    })
  );

  test.effect("clearing an unknown thread is not an error", () =>
    Effect.gen(function* () {
      const state = yield* StateStoreMemory;

      expect(yield* state.clearSession("never-seen")).toBeUndefined();
    })
  );

  test.effect("forgets the oldest thread rather than growing forever", () =>
    Effect.gen(function* () {
      // Nothing calls clearSession in normal operation, so an unbounded map
      // would hold one entry per thread the daemon has ever seen. Evicting the
      // oldest degrades to a cold start, which is the graceful failure.
      const state = yield* StateStoreMemory;

      for (let i = 0; i < 5010; i += 1) {
        yield* state.putSession(`thread-${i}`, {
          sessionId: `s${i}`,
          startedAt: i,
        });
      }

      expect(yield* state.getSession("thread-0")).toBeUndefined();
      expect(yield* state.getSession("thread-5009")).toMatchObject({
        sessionId: "s5009",
      });
    })
  );

  test.effect("two stores do not share state", () =>
    Effect.gen(function* () {
      const first = yield* StateStoreMemory;
      const second = yield* StateStoreMemory;

      yield* first.putSession("thread-a", {
        sessionId: "a",
        startedAt: 1,
      });

      expect(yield* second.getSession("thread-a")).toBeUndefined();
    })
  );
  test.effect("lists nothing before anything has been seen", () =>
    Effect.gen(function* () {
      const state = yield* StateStoreMemory;

      expect(yield* state.listThreads()).toEqual([]);
    })
  );

  test.effect("lists a thread that has a session but no listen state", () =>
    Effect.gen(function* () {
      const state = yield* StateStoreMemory;
      yield* state.putSession("thread-a", {
        sessionId: "sess-1",
        startedAt: 1_700_000_000_000,
      });

      const rows = yield* state.listThreads();

      expect(rows).toHaveLength(1);
      expect(rows[0]?.instanceId).toBe("thread-a");
      expect(rows[0]?.listen.engaged).toBe(false);
    })
  );

  test.effect("lists a thread that is only being listened to", () =>
    Effect.gen(function* () {
      // The half that would be missed by listing sessions alone, and the one
      // an operator is most likely asking about: watched, never answered.
      const state = yield* StateStoreMemory;
      yield* state.updateListen("thread-b", (listen) => ({
        ...listen,
        muted: true,
      }));

      const rows = yield* state.listThreads();

      expect(rows).toHaveLength(1);
      expect(rows[0]?.instanceId).toBe("thread-b");
      expect(rows[0]?.session).toBeUndefined();
      expect(rows[0]?.listen.muted).toBe(true);
    })
  );

  test.effect("counts a thread in both halves once", () =>
    Effect.gen(function* () {
      const state = yield* StateStoreMemory;
      yield* state.putSession("thread-c", {
        sessionId: "sess-2",
        startedAt: 1_700_000_000_000,
      });
      yield* state.updateListen("thread-c", (listen) => ({
        ...listen,
        engaged: true,
      }));

      const rows = yield* state.listThreads();

      expect(rows).toHaveLength(1);
      expect(rows[0]?.session?.sessionId).toBe("sess-2");
      expect(rows[0]?.listen.engaged).toBe(true);
    })
  );
});
