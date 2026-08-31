/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */

import { Context, Effect, Ref } from "effect";

import type { ThreadListen } from "../turn/listening/listen.ts";
import type { InterruptMode } from "./settings.ts";

import { UNSEEN_THREAD } from "../turn/listening/listen.ts";
import { DEFAULT_INTERRUPT_MODE } from "./settings.ts";

export interface ThreadSession {
  readonly sessionId: string;
  readonly startedAt: number;
}

export interface ThreadRow {
  readonly instanceId: string;
  readonly listen: ThreadListen;
  readonly session: ThreadSession | undefined;
}

export interface StateStoreShape {
  readonly getSession: (
    instanceId: string
  ) => Effect.Effect<ThreadSession | undefined>;
  readonly putSession: (
    instanceId: string,
    session: ThreadSession
  ) => Effect.Effect<void>;
  readonly clearSession: (instanceId: string) => Effect.Effect<void>;
  readonly getListen: (instanceId: string) => Effect.Effect<ThreadListen>;
  readonly listThreads: () => Effect.Effect<readonly ThreadRow[]>;
  readonly getInterruptMode: () => Effect.Effect<InterruptMode>;
  readonly putInterruptMode: (mode: InterruptMode) => Effect.Effect<void>;
  readonly updateListen: (
    instanceId: string,
    change: (state: ThreadListen) => ThreadListen
  ) => Effect.Effect<ThreadListen>;
}

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
