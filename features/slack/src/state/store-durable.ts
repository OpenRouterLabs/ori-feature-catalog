/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * store-durable.ts — thread state that survives a restart.
 *
 * The memory store lost every session and every mute on `ori start`, so a
 * restart cold-started every conversation and forgot which threads had been
 * stood down. Worse, a restart mid-turn dropped the answer silently, which is
 * the failure a person actually notices.
 *
 * Backed by the FRAMEWORK's store rather than a database of our own: the SDK
 * says a surface that persists state uses `Chat.stores` and "MUST NOT open its
 * own database" (RFC 0005). It is SQLite underneath, and the runtime owns its
 * teardown, so the WAL and SHM sidecars are flushed rather than left dangling.
 *
 * Schema is created on first use and is idempotent, so a fresh workspace and
 * an upgraded one take the same path.
 */

import type { StateStore as OriStateStore } from "ori";

import { Effect, Schema } from "effect";

import type { ThreadListen } from "../turn/listen.ts";
import type { StateStoreShape, ThreadSession } from "./store.ts";

import { UNSEEN_THREAD } from "../turn/listen.ts";
import { StateStore } from "./store.ts";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS slack_sessions (
     instance_id TEXT PRIMARY KEY,
     session_id  TEXT NOT NULL,
     started_at  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS slack_listens (
     instance_id TEXT PRIMARY KEY,
     state       TEXT NOT NULL
   )`,
] as const;

/**
 * A `Set` does not survive JSON, so participants ride as an array. Decoded
 * rather than cast: a row written by an older shape must not crash a turn.
 */
const StoredListen = Schema.Struct({
  engaged: Schema.Boolean,
  muted: Schema.Boolean,
  participants: Schema.Array(Schema.String),
  suppressed: Schema.Boolean,
});

/** A row that is not JSON, or not this shape, decodes as `None` either way. */
const decodeListen = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredListen)
);

const SessionRow = Schema.Struct({
  session_id: Schema.String,
  started_at: Schema.Number,
});

/** Named so the autofixer cannot strip a bare `undefined` and widen this. */
const NO_SESSION: ThreadSession | undefined = undefined;

const listenFrom = (raw: string): ThreadListen => {
  const decoded = decodeListen(raw);
  return decoded._tag === "Some"
    ? {
        engaged: decoded.value.engaged,
        muted: decoded.value.muted,
        participants: new Set(decoded.value.participants),
        suppressed: decoded.value.suppressed,
      }
    : UNSEEN_THREAD;
};

const listenTo = (state: ThreadListen): string =>
  JSON.stringify({
    engaged: state.engaged,
    muted: state.muted,
    participants: [...state.participants],
    suppressed: state.suppressed,
  });

/**
 * Every call is best-effort. A store that is unreachable costs a cold start,
 * which is what the memory store cost on every restart anyway — it must never
 * cost the turn.
 */
const warn =
  (op: string) =>
  (cause: unknown): Effect.Effect<void> =>
    Effect.logWarning(`[slack] state ${op} failed`, cause);

/** A write. Nothing to hand back, so nothing to fall back to. */
const write = (op: string, run: () => Promise<void>): Effect.Effect<void> =>
  Effect.tryPromise({
    catch: (cause) => new Error(String(cause)),
    try: run,
  }).pipe(Effect.catchCause(warn(op)));

/** A read. An unreachable store costs a cold start, never the turn. */
const read = <Row>(
  op: string,
  run: () => Promise<readonly Row[]>
): Effect.Effect<readonly Row[]> =>
  Effect.tryPromise({
    catch: (cause) => new Error(String(cause)),
    try: run,
  }).pipe(Effect.catchCause((cause) => warn(op)(cause).pipe(Effect.as([]))));

/** The session half: which agent conversation answers a thread. */
const sessions = (
  store: OriStateStore
): Pick<StateStoreShape, "clearSession" | "getSession" | "putSession"> => ({
  clearSession: (instanceId: string): Effect.Effect<void> =>
    write("clearSession", () =>
      store.exec("DELETE FROM slack_sessions WHERE instance_id = ?", [
        instanceId,
      ])
    ),

  getSession: (instanceId: string): Effect.Effect<ThreadSession | undefined> =>
    read("getSession", () =>
      store.query(
        "SELECT session_id, started_at FROM slack_sessions WHERE instance_id = ?",
        [instanceId]
      )
    ).pipe(
      Effect.map((rows) => {
        const decoded = Schema.decodeUnknownOption(SessionRow)(rows[0]);
        return decoded._tag === "Some"
          ? {
              sessionId: decoded.value.session_id,
              startedAt: decoded.value.started_at,
            }
          : NO_SESSION;
      })
    ),

  putSession: (
    instanceId: string,
    session: ThreadSession
  ): Effect.Effect<void> =>
    write("putSession", () =>
      store.exec(
        `INSERT INTO slack_sessions (instance_id, session_id, started_at)
         VALUES (?, ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET
           session_id = excluded.session_id,
           started_at = excluded.started_at`,
        [instanceId, session.sessionId, session.startedAt]
      )
    ),
});

/** The listen half: whether the bot is following a thread, and who is in it. */
const listens = (
  store: OriStateStore
): Pick<StateStoreShape, "getListen" | "updateListen"> => {
  const current = (instanceId: string): Effect.Effect<ThreadListen> =>
    read("getListen", () =>
      store.query<{ state: string }>(
        "SELECT state FROM slack_listens WHERE instance_id = ?",
        [instanceId]
      )
    ).pipe(
      Effect.map((rows) => {
        const raw = rows[0]?.state;
        return raw === undefined ? UNSEEN_THREAD : listenFrom(raw);
      })
    );

  return {
    getListen: current,

    updateListen: (
      instanceId: string,
      change: (state: ThreadListen) => ThreadListen
    ): Effect.Effect<ThreadListen> =>
      current(instanceId).pipe(
        Effect.map(change),
        Effect.tap((next) =>
          write("updateListen", () =>
            store.exec(
              `INSERT INTO slack_listens (instance_id, state) VALUES (?, ?)
               ON CONFLICT(instance_id) DO UPDATE SET state = excluded.state`,
              [instanceId, listenTo(next)]
            )
          )
        )
      ),
  };
};

export const StateStoreDurable = (
  store: OriStateStore
): Effect.Effect<StateStoreShape> =>
  Effect.gen(function* () {
    for (const statement of SCHEMA) {
      yield* write("migrate", () => store.exec(statement));
    }

    return StateStore.of({
      ...sessions(store),
      ...listens(store),
    });
  });

export type { ThreadSession };
