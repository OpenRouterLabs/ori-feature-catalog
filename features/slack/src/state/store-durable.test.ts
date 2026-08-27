import type { StateStore as OriStateStore } from "ori";

/* oxlint-disable import/no-relative-parent-imports typescript/no-unsafe-type-assertion -- modules inside this feature import siblings relatively, and bun:sqlite's variadic params are `any` at the boundary */
/**
 * store-durable.test.ts — thread state outlives the process.
 *
 * Against a real SQLite database, because the point of the change is what
 * survives a restart and an in-memory double would prove nothing.
 */
import { Database } from "bun:sqlite";

import {
  afterEach,
  describe,
  expect,
  test,
} from "#src/test-support/effect-test.ts";

import { Effect } from "effect";

import type { StateStoreShape } from "./store.ts";

import {
  answersUnaddressed,
  engage,
  isCrowded,
  mute,
  UNSEEN_THREAD,
  unmute,
  withParticipant,
} from "../turn/listen.ts";
import { InterruptMode } from "./settings.ts";
import { StateStoreDurable } from "./store-durable.ts";

/** Named so the autofixer cannot strip a bare `undefined` and widen it. */
const NO_VALUE: string | undefined = undefined;

const open = (): {
  readonly close: () => void;
  readonly store: OriStateStore;
} => {
  const db = new Database(":memory:");
  // The framework store's key-value side is a real map here rather than a
  // stub: the setting persists through it, so a no-op would prove nothing.
  const kv = new Map<string, string>();
  return {
    close: () => {
      db.close();
    },
    store: {
      exec: (sql, params) =>
        Promise.resolve(db.query(sql).run(...((params ?? []) as never[]))).then(
          () => {}
        ),
      get: (key: string) => Promise.resolve(kv.get(key) ?? NO_VALUE),
      name: "test",
      query: <Row>(sql: string, params?: readonly unknown[]) =>
        Promise.resolve(
          db.query(sql).all(...((params ?? []) as never[])) as readonly Row[]
        ),
      set: (key: string, value: string) => {
        kv.set(key, value);
        return Promise.resolve();
      },
    },
  };
};

let opened: ReturnType<typeof open> | undefined;

/** The database the current test opened, as the next process would find it. */
const sameDatabase = (): OriStateStore => {
  const current = opened;
  if (current === undefined) {
    throw new Error("no database open");
  }
  return current.store;
};

const store = (): Effect.Effect<StateStoreShape> =>
  Effect.suspend(() => {
    opened = open();
    return StateStoreDurable(opened.store);
  });

afterEach(() => {
  opened?.close();
  opened = undefined;
});

describe("state that survives a restart", () => {
  test.effect("a session is still there for the next process", () =>
    Effect.gen(function* () {
      // The memory store lost every session on `ori start`, so a restart
      // cold-started every conversation in the workspace.
      const first = yield* store();
      yield* first.putSession("C1:1700.1", {
        sessionId: "s-42",
        startedAt: 99,
      });

      // A second store over the same database is what the next process sees.
      const reopened = yield* StateStoreDurable(sameDatabase());
      const next = yield* reopened.getSession("C1:1700.1");

      expect(next?.sessionId).toBe("s-42");
      expect(next?.startedAt).toBe(99);
    })
  );

  test.effect("a thread it stood down from stays muted", () =>
    Effect.gen(function* () {
      const state = yield* store();
      yield* state.updateListen("C1:1700.2", mute);

      const after = yield* state.getListen("C1:1700.2");

      expect(after.muted).toBe(true);
    })
  );

  test.effect("participants survive the round trip, Set and all", () =>
    Effect.gen(function* () {
      // They are a Set, which does not survive JSON — so this is exactly the
      // shape a naive serialisation loses.
      const state = yield* store();
      yield* state.updateListen("C1:1700.3", (s) =>
        withParticipant(withParticipant(s, "U1"), "U2")
      );

      const after = yield* state.getListen("C1:1700.3");

      expect([...after.participants].toSorted()).toEqual(["U1", "U2"]);
    })
  );

  test.effect("a thread never seen reads as unseen, not as an error", () =>
    Effect.gen(function* () {
      const state = yield* store();

      expect(yield* state.getListen("C1:never")).toEqual(UNSEEN_THREAD);
    })
  );

  test.effect("clearing a session removes it", () =>
    Effect.gen(function* () {
      const state = yield* store();
      yield* state.putSession("C1:1700.4", {
        sessionId: "s",
        startedAt: 1,
      });
      yield* state.clearSession("C1:1700.4");

      expect(yield* state.getSession("C1:1700.4")).toBeUndefined();
    })
  );

  test.effect("a store that throws costs a cold start, never the turn", () =>
    Effect.gen(function* () {
      // Every call is best-effort: an unreachable store degrades to what the
      // memory store did on every restart anyway.
      const broken: OriStateStore = {
        exec: () => Promise.reject(new Error("disk gone")),
        get: () => Promise.resolve(NO_VALUE),
        name: "broken",
        query: () => Promise.reject(new Error("disk gone")),
        set: () => Promise.resolve(),
      };
      const state = yield* StateStoreDurable(broken);

      expect(yield* state.getSession("C1:x")).toBeUndefined();
      expect(yield* state.getListen("C1:x")).toEqual(UNSEEN_THREAD);
      yield* state.updateListen("C1:x", engage);
    })
  );
});

describe("a crowded thread stays crowded", () => {
  test.effect("the people in it are still there after a restart", () =>
    Effect.gen(function* () {
      // This is the whole reason participants are persisted. A busy thread had
      // correctly stood the bot down; `ori start` forgot who was in it, so the
      // count restarted at one and it answered plain replies in a room of five.
      const before = yield* store();
      yield* before.updateListen("C1:crowd", (s) =>
        mute(withParticipant(withParticipant(engage(s), "U_rob"), "U_jp"))
      );

      const after = yield* StateStoreDurable(sameDatabase());
      const seen = yield* after.getListen("C1:crowd");

      expect(isCrowded(seen)).toBe(true);
      expect(answersUnaddressed(seen)).toBe(false);
      expect(seen.engaged).toBe(true);
    })
  );

  test.effect(
    "an explicit unmute survives too, so it is not re-muted on boot",
    () =>
      Effect.gen(function* () {
        const before = yield* store();
        yield* before.updateListen("C1:opted-in", (s) =>
          unmute(withParticipant(withParticipant(s, "U_rob"), "U_jp"))
        );

        const after = yield* StateStoreDurable(sameDatabase());
        const seen = yield* after.getListen("C1:opted-in");

        expect(seen.suppressed).toBe(true);
        expect(answersUnaddressed(seen)).toBe(true);
      })
  );
});

describe("listing every thread the database knows", () => {
  test.effect("lists nothing from a fresh database", () =>
    Effect.gen(function* () {
      const state = yield* store();

      expect(yield* state.listThreads()).toEqual([]);
    })
  );

  test.effect("finds a thread that only ever had a session", () =>
    Effect.gen(function* () {
      const state = yield* store();
      yield* state.putSession("thread-a", {
        sessionId: "sess-1",
        startedAt: 1_700_000_000_000,
      });

      const rows = yield* state.listThreads();

      expect(rows).toHaveLength(1);
      expect(rows[0]?.instanceId).toBe("thread-a");
      expect(rows[0]?.session?.sessionId).toBe("sess-1");
    })
  );

  test.effect("finds a thread that was only ever listened to", () =>
    Effect.gen(function* () {
      // The two tables are written independently, so neither one alone is the
      // list. A thread muted before the bot ever answered lives only here.
      const state = yield* store();
      yield* state.updateListen("thread-b", mute);

      const rows = yield* state.listThreads();

      expect(rows).toHaveLength(1);
      expect(rows[0]?.instanceId).toBe("thread-b");
      expect(rows[0]?.listen.muted).toBe(true);
      expect(rows[0]?.session).toBeUndefined();
    })
  );

  test.effect("a thread in both tables is listed once, joined", () =>
    Effect.gen(function* () {
      // What the UNION is for: the same instance id in both halves must not
      // render as two rows.
      const state = yield* store();
      yield* state.putSession("thread-c", {
        sessionId: "sess-2",
        startedAt: 1_700_000_000_000,
      });
      yield* state.updateListen("thread-c", engage);

      const rows = yield* state.listThreads();

      expect(rows).toHaveLength(1);
      expect(rows[0]?.session?.sessionId).toBe("sess-2");
      expect(rows[0]?.listen.engaged).toBe(true);
    })
  );

  test.effect("survives into the next process", () =>
    Effect.gen(function* () {
      const state = yield* store();
      yield* state.putSession("thread-d", {
        sessionId: "sess-3",
        startedAt: 1_700_000_000_000,
      });
      yield* state.updateListen("thread-d", mute);

      const restarted = yield* StateStoreDurable(sameDatabase());
      const rows = yield* restarted.listThreads();

      expect(rows).toHaveLength(1);
      expect(rows[0]?.listen.muted).toBe(true);
      expect(rows[0]?.session?.sessionId).toBe("sess-3");
    })
  );
});

describe("the interrupt setting", () => {
  test.effect("defaults to steering, which is what the surface did before", () =>
    Effect.gen(function* () {
      const state = yield* store();

      expect(yield* state.getInterruptMode()).toBe(InterruptMode.Steer);
    })
  );

  test.effect("a saved setting is still there for the next process", () =>
    Effect.gen(function* () {
      // The whole point of settling this in the store: an operator who turned
      // steering off should not have it turned back on by a restart.
      const state = yield* store();
      yield* state.putInterruptMode(InterruptMode.Queue);

      const restarted = yield* StateStoreDurable(sameDatabase());

      expect(yield* restarted.getInterruptMode()).toBe(InterruptMode.Queue);
    })
  );

  test.effect("a value written by an older shape reads as the default", () =>
    Effect.gen(function* () {
      const state = yield* store();
      yield* Effect.promise(() => sameDatabase().set("slack:interruptMode", "?"));

      expect(yield* state.getInterruptMode()).toBe(InterruptMode.Steer);
    })
  );
});
