/**
 * carry.test.ts — moving a conversation without losing it.
 *
 * Carry is a rebinding, so every case here is about what the store looks like
 * afterwards. The two that matter are the ones that are silently wrong rather
 * than loudly broken: a binding that got copied instead of moved, and an old
 * thread left able to answer with nothing behind it.
 */

import { Effect } from "effect";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import type { StateStoreShape } from "../state/store.ts";
import type { ThreadRef } from "../thread/thread.ts";
import type { CarryResult } from "./carry.ts";

import { StateStore, StateStoreMemory } from "../state/store.ts";
import { threadInstanceId } from "../thread/thread.ts";
import { carrySession, CarryOutcome } from "./carry.ts";

const FROM = {
  channelId: "C1",
  teamId: "T1",
  threadTs: "1700.1",
};

const TO = {
  ...FROM,
  threadTs: "1800.2",
};

const SESSION = {
  sessionId: "sess-live",
  startedAt: 1_700_000_000_000,
};

const seeded = Effect.fn("test.seeded")(function* () {
  const store = yield* StateStoreMemory;
  yield* store.putSession(threadInstanceId(FROM), SESSION);
  return store;
});

/**
 * `carrySession` asks the graph for its store, so a test provides one — the
 * same store it then asserts against.
 */
const carrying = (
  store: StateStoreShape,
  input: { readonly from: ThreadRef; readonly to: ThreadRef }
): Effect.Effect<CarryResult> =>
  carrySession(input).pipe(Effect.provideService(StateStore, store));

describe("carrying a session", () => {
  test.effect("the destination thread ends up owning the session", () =>
    Effect.gen(function* () {
      const store = yield* seeded();

      const result = yield* carrying(store, {
        from: FROM,
        to: TO,
      });

      expect(result.kind).toBe(CarryOutcome.Carried);
      expect(yield* store.getSession(threadInstanceId(TO))).toEqual(SESSION);
    })
  );

  test.effect("the origin thread stops owning it — moved, not copied", () =>
    Effect.gen(function* () {
      // Two threads bound to one session would each get their own turn queue,
      // and two turns would interleave writes into one agent context.
      const store = yield* seeded();

      yield* carrying(store, {
        from: FROM,
        to: TO,
      });

      expect(yield* store.getSession(threadInstanceId(FROM))).toBeUndefined();
    })
  );

  test.effect("the origin thread is muted, not merely released", () =>
    Effect.gen(function* () {
      // Released but still engaged, the next reply there cold-starts a fresh
      // session and the bot reads as having amnesia rather than having moved.
      const store = yield* seeded();

      yield* carrying(store, {
        from: FROM,
        to: TO,
      });

      expect((yield* store.getListen(threadInstanceId(FROM))).muted).toBe(true);
    })
  );

  test.effect("the destination is engaged, so replies reach the agent", () =>
    Effect.gen(function* () {
      // The bot opened the thread and named someone in it. Requiring a mention
      // to continue a conversation the bot itself moved would be absurd.
      const store = yield* seeded();

      yield* carrying(store, {
        from: FROM,
        to: TO,
      });

      expect((yield* store.getListen(threadInstanceId(TO))).engaged).toBe(true);
    })
  );

  test.effect("the conversation keeps its age", () =>
    Effect.gen(function* () {
      // `startedAt` records when the conversation began, not when it last
      // changed address — the dashboard sorts on it.
      const store = yield* seeded();

      yield* carrying(store, {
        from: FROM,
        to: TO,
      });

      expect(
        (yield* store.getSession(threadInstanceId(TO)))?.startedAt
      ).toBe(SESSION.startedAt);
    })
  );

  test.effect("a thread that never ran has nothing to carry", () =>
    Effect.gen(function* () {
      const store = yield* StateStoreMemory;

      const result = yield* carrying(store, {
        from: FROM,
        to: TO,
      });

      expect(result.kind).toBe(CarryOutcome.NothingToCarry);
    })
  );

  test.effect("a failed carry leaves the origin alone", () =>
    Effect.gen(function* () {
      // Nothing to carry must not mute the origin on its way out: the thread
      // is still live, it simply has not run yet.
      const store = yield* StateStoreMemory;

      yield* carrying(store, {
        from: FROM,
        to: TO,
      });

      expect((yield* store.getListen(threadInstanceId(FROM))).muted).toBe(
        false
      );
      expect(yield* store.getSession(threadInstanceId(TO))).toBeUndefined();
    })
  );

  test.effect("carrying twice moves it on again rather than duplicating", () =>
    Effect.gen(function* () {
      const store = yield* seeded();
      const onward = {
        ...FROM,
        threadTs: "1900.3",
      };

      yield* carrying(store, {
        from: FROM,
        to: TO,
      });
      yield* carrying(store, {
        from: TO,
        to: onward,
      });

      expect(yield* store.getSession(threadInstanceId(onward))).toEqual(
        SESSION
      );
      expect(yield* store.getSession(threadInstanceId(TO))).toBeUndefined();
      expect(yield* store.getSession(threadInstanceId(FROM))).toBeUndefined();
    })
  );
});
