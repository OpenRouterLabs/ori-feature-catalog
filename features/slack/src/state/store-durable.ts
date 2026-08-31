/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */

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

const StoredListen = Schema.Struct({
  engaged: Schema.Boolean,
  muted: Schema.Boolean,
  participants: Schema.Array(Schema.String),
  suppressed: Schema.Boolean,
});

const decodeListen = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredListen)
);

const SessionRow = Schema.Struct({
  session_id: Schema.String,
  started_at: Schema.Number,
});

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

const warn =
  (op: string) =>
  (cause: unknown): Effect.Effect<void> =>
    Effect.logWarning(`[slack] state ${op} failed`, cause);

const write = (op: string, run: () => Promise<void>): Effect.Effect<void> =>
  Effect.tryPromise({
    catch: (cause) => new Error(String(cause)),
    try: run,
  }).pipe(Effect.catchCause(warn(op)), Effect.withSpan("Slack.state.write"));

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

const ThreadRowShape = Schema.Struct({
  instance_id: Schema.String,
  session_id: Schema.NullOr(Schema.String),
  started_at: Schema.NullOr(Schema.Number),
  state: Schema.NullOr(Schema.String),
});

const decodeThreadRow = Schema.decodeUnknownOption(ThreadRowShape);

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

const INTERRUPT_MODE_KEY = "slack:interruptMode";

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
