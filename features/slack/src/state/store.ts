import { Context, Effect, Ref, Schema } from "effect";

import type { ThreadListen } from "#src/turn/listening/listen.ts";
import type { InterruptMode } from "./settings.ts";

import { functionSchema, opaqueSchema } from "#src/schema-support.ts";
import { UNSEEN_THREAD } from "#src/turn/listening/listen.ts";
import { DEFAULT_INTERRUPT_MODE } from "./settings.ts";

const ThreadSessionSchema = Schema.Struct({
  sessionId: Schema.String,
  startedAt: Schema.Number,
});

export type ThreadSession = typeof ThreadSessionSchema.Type;

const ThreadRowSchema = Schema.Struct({
  instanceId: Schema.String,
  listen: opaqueSchema<ThreadListen>("ThreadRow.listen"),
  session: Schema.UndefinedOr(ThreadSessionSchema),
});

export type ThreadRow = typeof ThreadRowSchema.Type;

const StateStoreShapeSchema = Schema.Struct({
  getSession:
    functionSchema<
      (instanceId: string) => Effect.Effect<ThreadSession | undefined>
    >("StateStoreShape.getSession"),
  putSession:
    functionSchema<
      (instanceId: string, session: ThreadSession) => Effect.Effect<void>
    >("StateStoreShape.putSession"),
  clearSession:
    functionSchema<(instanceId: string) => Effect.Effect<void>>(
      "StateStoreShape.clearSession"
    ),
  getListen:
    functionSchema<(instanceId: string) => Effect.Effect<ThreadListen>>(
      "StateStoreShape.getListen"
    ),
  listThreads:
    functionSchema<() => Effect.Effect<readonly ThreadRow[]>>(
      "StateStoreShape.listThreads"
    ),
  getInterruptMode:
    functionSchema<() => Effect.Effect<InterruptMode>>(
      "StateStoreShape.getInterruptMode"
    ),
  putInterruptMode:
    functionSchema<(mode: InterruptMode) => Effect.Effect<void>>(
      "StateStoreShape.putInterruptMode"
    ),
  updateListen:
    functionSchema<
      (
        instanceId: string,
        change: (state: ThreadListen) => ThreadListen
      ) => Effect.Effect<ThreadListen>
    >("StateStoreShape.updateListen"),
});

export type StateStoreShape = typeof StateStoreShapeSchema.Type;

export class StateStore extends Context.Service<StateStore, StateStoreShape>()(
  "ori/slack/StateStore"
) {}

const MAX_TRACKED_THREADS = 5000;

const bounded = <T>(
  current: Map<string, T>,
  key: string,
  value: T
): Map<string, T> => {
  const next = new Map(current).set(key, value);
  while (next.size > MAX_TRACKED_THREADS) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    next.delete(oldest);
  }
  return next;
};

export const StateStoreMemory = Effect.gen(function* () {
  const sessions = yield* Ref.make(new Map<string, ThreadSession>());
  const listens = yield* Ref.make(new Map<string, ThreadListen>());
  const interruptMode = yield* Ref.make(DEFAULT_INTERRUPT_MODE);

  return StateStore.of({
    clearSession: (instanceId) =>
      Ref.update(sessions, (current) => {
        const next = new Map(current);
        next.delete(instanceId);
        return next;
      }).pipe(Effect.withSpan("Slack.state.clearSession")),

    getInterruptMode: () =>
      Ref.get(interruptMode).pipe(
        Effect.withSpan("Slack.state.getInterruptMode")
      ),

    putInterruptMode: (mode) =>
      Ref.set(interruptMode, mode).pipe(
        Effect.withSpan("Slack.state.putInterruptMode")
      ),

    getListen: (instanceId) =>
      Ref.get(listens).pipe(
        Effect.map((current) => current.get(instanceId) ?? UNSEEN_THREAD),
        Effect.withSpan("Slack.state.getListen")
      ),

    listThreads: () =>
      Effect.all([Ref.get(sessions), Ref.get(listens)]).pipe(
        Effect.map(([sessionsNow, listensNow]) =>
          [...new Set([...sessionsNow.keys(), ...listensNow.keys()])].map(
            (instanceId) => ({
              instanceId,
              listen: listensNow.get(instanceId) ?? UNSEEN_THREAD,
              session: sessionsNow.get(instanceId),
            })
          )
        ),
        Effect.withSpan("Slack.state.listThreads")
      ),

    getSession: (instanceId) =>
      Ref.get(sessions).pipe(
        Effect.map((current) => current.get(instanceId)),
        Effect.withSpan("Slack.state.getSession")
      ),

    putSession: (instanceId, session) =>
      Ref.update(sessions, (current) =>
        bounded(current, instanceId, session)
      ).pipe(Effect.withSpan("Slack.state.putSession")),

    updateListen: (instanceId, change) =>
      Ref.modify(listens, (current) => {
        const next = change(current.get(instanceId) ?? UNSEEN_THREAD);
        return [next, bounded(current, instanceId, next)];
      }).pipe(Effect.withSpan("Slack.state.updateListen")),
  });
}).pipe(Effect.withSpan("Slack.state.openMemory"));
