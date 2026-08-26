/**
 * notes.ts — the surface talking about itself, rather than answering.
 *
 * A queue notice, a step-back note: one line in a thread, from the surface
 * rather than from the agent. Every one is best-effort — a note that cannot be
 * posted must never fault the turn it was describing.
 *
 * Also binds the engagement decision to the live store, because that is where
 * the note posting it needs already lives.
 */

import { Context, Effect } from "effect";

import type { SlackConfig } from "./config.ts";
import type { SlackServices } from "./layers.ts";
import type { ThreadRef } from "./thread/thread.ts";
import type { EngagementDeps } from "./turn/engagement.ts";

import { makeMessageReply } from "./message-reply/reply-live.ts";
import { StateStore } from "./state/store.ts";
import { AssistantThreads } from "./thread/assistant.ts";
import { cancelThread } from "./thread/registry.ts";
import { gateContextOf } from "./turn/gates.ts";

const runWith = <A>(
  context: Context.Context<SlackServices>,
  effect: Effect.Effect<A, never, SlackServices>
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provideContext(context)));

const postNote = (
  context: Context.Context<SlackServices>,
  ref: ThreadRef,
  text: string
): Promise<void> =>
  runWith(
    context,
    makeMessageReply(ref).pipe(
      Effect.flatMap((reply) => reply.reply(text)),
      Effect.ignore
    )
  );

/**
 * Show the native indicator the moment the message lands.
 *
 * Before the session lookup, before the prompt is even
 * assembled — all of which take seconds a reader spends looking at nothing.
 *
 * The only indicator the surface sets. Once the agent is running it says what
 * it is doing itself, through `slack-status`.
 */
export const startStatus = (
  context: Context.Context<SlackServices>,
  ref: ThreadRef
): Promise<void> =>
  Effect.runPromise(
    Context.get(context, AssistantThreads).setStatus(
      {
        channelId: ref.channelId,
        threadTs: ref.threadTs,
      },
      "is starting up…",
      ["is starting up…"]
    )
  );

/**
 * Say that a turn died before it could answer.
 *
 * A failure between the Slack event and the worker — fetching attachments,
 * reading thread history, assembling the prompt — was caught and LOGGED, and
 * the thread got nothing at all. Silence is the one outcome a reader cannot
 * act on: they cannot tell it from slow, so they wait.
 */
export const sayFailed = (
  context: Context.Context<SlackServices>,
  ref: ThreadRef
): Promise<void> =>
  postNote(
    context,
    ref,
    "_I hit an error before I could start on that — nothing ran. Worth asking again._"
  );

/** Told only when the caller actually has to wait, so it is never noise. */
export const postQueuedNotice = (
  context: Context.Context<SlackServices>,
  ref: ThreadRef
): Promise<void> =>
  postNote(
    context,
    ref,
    "_Queued — starting once the current run in this thread finishes._"
  );

/**
 * The engagement decision, bound to the live store.
 *
 * `botUserId` prefers the resolved identity: an unset `SLACK_BOT_USER_ID` would
 * silently degrade the crowd tally to counting no bots at all.
 */
export const engagementDeps = (input: {
  readonly botUserId: string | undefined;
  readonly config: SlackConfig;
  readonly context: Context.Context<SlackServices>;
}): EngagementDeps => {
  const store = Context.get(input.context, StateStore);
  return {
    gates: {
      ...gateContextOf(input.config),
      botUserId: input.botUserId ?? input.config.botUserId,
    },
    note: (ref, text) => postNote(input.context, ref, text),
    stop: (key) => {
      cancelThread(key);
    },
    readListen: (key) => Effect.runPromise(store.getListen(key)),
    updateListen: (key, change) =>
      Effect.runPromise(store.updateListen(key, change)),
  };
};
