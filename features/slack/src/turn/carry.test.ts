import { Effect } from "effect";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { StateStore, StateStoreMemory, type StateStoreShape } from "#src/state/store.ts";
import { type ThreadRef, threadInstanceId } from "#src/thread/index.ts";
import { CarryOutcome, type CarryResult, carrySession } from "./carry.ts";


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
