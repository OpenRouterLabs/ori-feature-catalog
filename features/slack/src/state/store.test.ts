/* oxlint-disable typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/max-lines-per-function eslint/require-await eslint/no-unsafe-optional-chaining typescript/no-invalid-void-type promise/avoid-new promise/param-names unicorn/consistent-function-scoping -- test doubles assert on recorded `unknown` args and stand in for Slack SDK shapes; cases read better whole than split */
import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { StateStoreMemory } from "./store.ts";

const store = () => Effect.runPromise(StateStoreMemory);

describe("StateStoreMemory", () => {
  test("returns undefined for an unknown thread", async () => {
    const state = await store();

    await expect(
      Effect.runPromise(state.getSession("slack:T1:C1:1.1"))
    ).resolves.toBeUndefined();
  });

  test("round-trips a session", async () => {
    const state = await store();
    const session = {
      sessionId: "sess-1",
      startedAt: 1_700_000_000_000,
    };

    await Effect.runPromise(state.putSession("thread-a", session));

    await expect(
      Effect.runPromise(state.getSession("thread-a"))
    ).resolves.toEqual(session);
  });

  test("keeps threads independent", async () => {
    // A shared entry would let two conversations resume each other's session.
    const state = await store();

    await Effect.runPromise(
      state.putSession("thread-a", {
        sessionId: "a",
        startedAt: 1,
      })
    );
    await Effect.runPromise(
      state.putSession("thread-b", {
        sessionId: "b",
        startedAt: 2,
      })
    );

    await expect(
      Effect.runPromise(state.getSession("thread-a"))
    ).resolves.toMatchObject({ sessionId: "a" });
    await expect(
      Effect.runPromise(state.getSession("thread-b"))
    ).resolves.toMatchObject({ sessionId: "b" });
  });

  test("a later put replaces the earlier session", async () => {
    const state = await store();

    await Effect.runPromise(
      state.putSession("thread-a", {
        sessionId: "old",
        startedAt: 1,
      })
    );
    await Effect.runPromise(
      state.putSession("thread-a", {
        sessionId: "new",
        startedAt: 2,
      })
    );

    await expect(
      Effect.runPromise(state.getSession("thread-a"))
    ).resolves.toMatchObject({ sessionId: "new" });
  });

  test("clearSession forgets the thread", async () => {
    const state = await store();

    await Effect.runPromise(
      state.putSession("thread-a", {
        sessionId: "a",
        startedAt: 1,
      })
    );
    await Effect.runPromise(state.clearSession("thread-a"));

    await expect(
      Effect.runPromise(state.getSession("thread-a"))
    ).resolves.toBeUndefined();
  });

  test("clearing an unknown thread is not an error", async () => {
    const state = await store();

    await expect(
      Effect.runPromise(state.clearSession("never-seen"))
    ).resolves.toBeUndefined();
  });

  test("forgets the oldest thread rather than growing forever", async () => {
    // Nothing calls clearSession in normal operation, so an unbounded map
    // would hold one entry per thread the daemon has ever seen. Evicting the
    // oldest degrades to a cold start, which is the graceful failure.
    const state = await store();

    for (let i = 0; i < 5010; i += 1) {
      await Effect.runPromise(
        state.putSession(`thread-${i}`, {
          sessionId: `s${i}`,
          startedAt: i,
        })
      );
    }

    await expect(
      Effect.runPromise(state.getSession("thread-0"))
    ).resolves.toBeUndefined();
    await expect(
      Effect.runPromise(state.getSession("thread-5009"))
    ).resolves.toMatchObject({ sessionId: "s5009" });
  });

  test("two stores do not share state", async () => {
    const first = await store();
    const second = await store();

    await Effect.runPromise(
      first.putSession("thread-a", {
        sessionId: "a",
        startedAt: 1,
      })
    );

    await expect(
      Effect.runPromise(second.getSession("thread-a"))
    ).resolves.toBeUndefined();
  });
});
