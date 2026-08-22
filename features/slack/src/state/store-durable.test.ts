import type { StateStore as OriStateStore } from "ori";

/* oxlint-disable import/no-relative-parent-imports typescript/no-unsafe-type-assertion -- modules inside this feature import siblings relatively, and bun:sqlite's variadic params are `any` at the boundary */
/**
 * store-durable.test.ts — thread state outlives the process.
 *
 * Against a real SQLite database, because the point of the change is what
 * survives a restart and an in-memory double would prove nothing.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

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
import { StateStoreDurable } from "./store-durable.ts";

/** Named so the autofixer cannot strip a bare `undefined` and widen it. */
const NO_VALUE: string | undefined = undefined;

const open = (): {
  readonly close: () => void;
  readonly store: OriStateStore;
} => {
  const db = new Database(":memory:");
  return {
    close: () => {
      db.close();
    },
    store: {
      exec: (sql, params) =>
        Promise.resolve(db.query(sql).run(...((params ?? []) as never[]))).then(
          () => {}
        ),
      get: () => Promise.resolve(NO_VALUE),
      name: "test",
      query: <Row>(sql: string, params?: readonly unknown[]) =>
        Promise.resolve(
          db.query(sql).all(...((params ?? []) as never[])) as readonly Row[]
        ),
      set: () => Promise.resolve(),
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

const store = async (): Promise<StateStoreShape> => {
  opened = open();
  return await Effect.runPromise(StateStoreDurable(opened.store));
};

afterEach(() => {
  opened?.close();
  opened = undefined;
});

describe("state that survives a restart", () => {
  test("a session is still there for the next process", async () => {
    // The memory store lost every session on `ori start`, so a restart
    // cold-started every conversation in the workspace.
    const first = await store();
    await Effect.runPromise(
      first.putSession("C1:1700.1", {
        sessionId: "s-42",
        startedAt: 99,
      })
    );

    // A second store over the same database is what the next process sees.
    const reopened = await Effect.runPromise(StateStoreDurable(sameDatabase()));
    const next = await Effect.runPromise(reopened.getSession("C1:1700.1"));

    expect(next?.sessionId).toBe("s-42");
    expect(next?.startedAt).toBe(99);
  });

  test("a thread it stood down from stays muted", async () => {
    const state = await store();
    await Effect.runPromise(state.updateListen("C1:1700.2", mute));

    const after = await Effect.runPromise(state.getListen("C1:1700.2"));

    expect(after.muted).toBe(true);
  });

  test("participants survive the round trip, Set and all", async () => {
    // They are a Set, which does not survive JSON — so this is exactly the
    // shape a naive serialisation loses.
    const state = await store();
    await Effect.runPromise(
      state.updateListen("C1:1700.3", (s) =>
        withParticipant(withParticipant(s, "U1"), "U2")
      )
    );

    const after = await Effect.runPromise(state.getListen("C1:1700.3"));

    expect([...after.participants].toSorted()).toEqual(["U1", "U2"]);
  });

  test("a thread never seen reads as unseen, not as an error", async () => {
    const state = await store();

    expect(await Effect.runPromise(state.getListen("C1:never"))).toEqual(
      UNSEEN_THREAD
    );
  });

  test("clearing a session removes it", async () => {
    const state = await store();
    await Effect.runPromise(
      state.putSession("C1:1700.4", {
        sessionId: "s",
        startedAt: 1,
      })
    );
    await Effect.runPromise(state.clearSession("C1:1700.4"));

    expect(
      await Effect.runPromise(state.getSession("C1:1700.4"))
    ).toBeUndefined();
  });

  test("a store that throws costs a cold start, never the turn", async () => {
    // Every call is best-effort: an unreachable store degrades to what the
    // memory store did on every restart anyway.
    const broken: OriStateStore = {
      exec: () => Promise.reject(new Error("disk gone")),
      get: () => Promise.resolve(NO_VALUE),
      name: "broken",
      query: () => Promise.reject(new Error("disk gone")),
      set: () => Promise.resolve(),
    };
    const state = await Effect.runPromise(StateStoreDurable(broken));

    expect(await Effect.runPromise(state.getSession("C1:x"))).toBeUndefined();
    expect(await Effect.runPromise(state.getListen("C1:x"))).toEqual(
      UNSEEN_THREAD
    );
    await Effect.runPromise(state.updateListen("C1:x", engage));
  });
});

describe("a crowded thread stays crowded", () => {
  test("the people in it are still there after a restart", async () => {
    // This is the whole reason participants are persisted. A busy thread had
    // correctly stood the bot down; `ori start` forgot who was in it, so the
    // count restarted at one and it answered plain replies in a room of five.
    const before = await store();
    await Effect.runPromise(
      before.updateListen("C1:crowd", (s) =>
        mute(withParticipant(withParticipant(engage(s), "U_rob"), "U_jp"))
      )
    );

    const after = await Effect.runPromise(StateStoreDurable(sameDatabase()));
    const seen = await Effect.runPromise(after.getListen("C1:crowd"));

    expect(isCrowded(seen)).toBe(true);
    expect(answersUnaddressed(seen)).toBe(false);
    expect(seen.engaged).toBe(true);
  });

  test("an explicit unmute survives too, so it is not re-muted on boot", async () => {
    const before = await store();
    await Effect.runPromise(
      before.updateListen("C1:opted-in", (s) =>
        unmute(withParticipant(withParticipant(s, "U_rob"), "U_jp"))
      )
    );

    const after = await Effect.runPromise(StateStoreDurable(sameDatabase()));
    const seen = await Effect.runPromise(after.getListen("C1:opted-in"));

    expect(seen.suppressed).toBe(true);
    expect(answersUnaddressed(seen)).toBe(true);
  });
});
