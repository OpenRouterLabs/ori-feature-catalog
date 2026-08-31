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

import type { ThreadListen } from "../turn/listening/listen.ts";
import type { InterruptMode } from "./settings.ts";
import type { StateStoreShape, ThreadRow, ThreadSession } from "./store.ts";

import { UNSEEN_THREAD } from "../turn/listening/listen.ts";
import { interruptModeFrom } from "./settings.ts";
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

/**
 * A write. Nothing to hand back, so nothing to fall back to.
 *
 * Spanned at the SQLite edge rather than per caller: every method already
 * carries its own span, so this one separates the time in the database from
 * the time spent decoding what came back.
 */
const write = (op: string, run: () => Promise<void>): Effect.Effect<void> =>
  Effect.tryPromise({
    catch: (cause) => new Error(String(cause)),
    try: run,
  }).pipe(Effect.catchCause(warn(op)), Effect.withSpan("Slack.state.write"));

/** A read. An unreachable store costs a cold start, never the turn. */
const read = <Row>(
  op: string,
  run: () => Promise<readonly Row[]>
): Effect.Effect<readonly Row[]> =>
  Effect.tryPromise({
    catch: (cause) => new Error(String(cause)),
    try: run,
  }).pipe(
    Effect.catchCause((cause) => warn(op)(cause).pipe(Effect.as([]))),
    Effect.withSpan("Slack.state.read")
  );

/** The session half: which agent conversation answers a thread. */
const sessions = (
  store: OriStateStore
): Pick<StateStoreShape, "clearSession" | "getSession" | "putSession"> => ({
  clearSession: (instanceId: string): Effect.Effect<void> =>
    write("clearSession", () =>
      store.exec("DELETE FROM slack_sessions WHERE instance_id = ?", [
        instanceId,
      ])
    ).pipe(Effect.withSpan("Slack.state.clearSession")),

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
      }),
      Effect.withSpan("Slack.state.getSession")
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
    ).pipe(Effect.withSpan("Slack.state.putSession")),
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
      }),
      Effect.withSpan("Slack.state.getListen")
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
        ),
        Effect.withSpan("Slack.state.updateListen")
      ),
  };
};

/** A joined row. Either half may be absent, so both sides are nullable. */
const ThreadRowShape = Schema.Struct({
  instance_id: Schema.String,
  session_id: Schema.NullOr(Schema.String),
  started_at: Schema.NullOr(Schema.Number),
  state: Schema.NullOr(Schema.String),
});

const decodeThreadRow = Schema.decodeUnknownOption(ThreadRowShape);

/**
 * Every thread either table knows about.
 *
 * A FULL OUTER JOIN in SQLite's dialect: the two halves are written
 * independently, so neither table alone is the list. A row that does not
 * decode is dropped rather than failing the page — the same choice
 * `listenFrom` makes for a single row, for the same reason.
 */
const listThreads =
  (store: OriStateStore) => (): Effect.Effect<readonly ThreadRow[]> =>
    read("listThreads", () =>
      store.query(
        `SELECT s.instance_id AS instance_id, s.session_id, s.started_at, l.state
           FROM slack_sessions s
           LEFT JOIN slack_listens l ON l.instance_id = s.instance_id
         UNION
         SELECT l.instance_id AS instance_id, s.session_id, s.started_at, l.state
           FROM slack_listens l
           LEFT JOIN slack_sessions s ON s.instance_id = l.instance_id`
      )
    ).pipe(
      Effect.map((rows) =>
        rows.flatMap((row) => {
          const decoded = decodeThreadRow(row);
          if (decoded._tag === "None") {
            return [];
          }
          const { instance_id, session_id, started_at, state } = decoded.value;
          return [
            {
              instanceId: instance_id,
              listen: state === null ? UNSEEN_THREAD : listenFrom(state),
              session:
                session_id === null || started_at === null
                  ? NO_SESSION
                  : { sessionId: session_id, startedAt: started_at },
            },
          ];
        })
      ),
      Effect.withSpan("Slack.state.listThreads")
    );

/** The framework store's key-value side; one row does not want a table. */
const INTERRUPT_MODE_KEY = "slack:interruptMode";

/**
 * The operator's setting, and the write that changes it.
 *
 * Best-effort like every other read here: a store that cannot answer yields
 * the default rather than failing the turn that asked. The cost of guessing
 * wrong is one message steered that should have queued, which is what the
 * surface did unconditionally before this existed.
 */
const settings = (
  store: OriStateStore
): Pick<StateStoreShape, "getInterruptMode" | "putInterruptMode"> => ({
  getInterruptMode: (): Effect.Effect<InterruptMode> =>
    Effect.tryPromise({
      catch: (cause) => new Error(String(cause)),
      try: () => store.get(INTERRUPT_MODE_KEY),
    }).pipe(
      Effect.map(interruptModeFrom),
      Effect.catchCause((cause) =>
        warn("getInterruptMode")(cause).pipe(
          Effect.as(interruptModeFrom(undefined))
        )
      ),
      Effect.withSpan("Slack.state.getInterruptMode")
    ),

  putInterruptMode: (mode: InterruptMode): Effect.Effect<void> =>
    write("putInterruptMode", () => store.set(INTERRUPT_MODE_KEY, mode)).pipe(
      Effect.withSpan("Slack.state.putInterruptMode")
    ),
});

export const StateStoreDurable = Effect.fn("Slack.state.openDurable")(
  function* (store: OriStateStore): Effect.fn.Return<StateStoreShape> {
    for (const statement of SCHEMA) {
      yield* write("migrate", () => store.exec(statement));
    }

    return StateStore.of({
      ...sessions(store),
      ...listens(store),
      ...settings(store),
      listThreads: listThreads(store),
    });
  }
);

export type { ThreadSession };
