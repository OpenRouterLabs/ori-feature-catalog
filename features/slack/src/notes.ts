/**
 * notes.ts — the surface talking about itself, rather than answering.
 *
 * A queue notice, a step-back note: one line in a thread, from the surface
 * rather than from the agent. Every one is best-effort — a note that cannot be
 * posted must never fault the turn it was describing.
 *
 * Every note is an EFFECT, named, and stays one. The callers are already inside
 * the graph, so the services a note needs are already in scope: crossing out to
 * a Promise and back would start a fresh fiber with no context, which is why
 * this file used to carry a helper re-providing the context at every call.
 *
 * Also binds the engagement decision to the live store, because that is where
 * the note posting it needs already lives.
 */

import { Context, Effect } from "effect";

import { bestEffort } from "./helpers/best-effort.ts";

import type { SlackConfig } from "./config.ts";
import type { SlackServices } from "./layers.ts";
import type { ThreadRef } from "./thread/thread.ts";
import type { EngagementDeps } from "./turn/listening/engagement.ts";

import { SlackClient } from "./client/index.ts";
import { makeMessageReply } from "./message-reply/reply-live.ts";
import { StateStore } from "./state/store.ts";
import { AssistantThreads } from "./thread/assistant.ts";
import { cancelThread } from "./thread/registry.ts";
import { gateContextOf } from "./turn/listening/gates.ts";

/**
 * One line into a thread, best-effort.
 *
 * `ignore` covers the post itself: a note the surface could not deliver is not
 * worth faulting the turn it was describing over.
 */
const postNote = Effect.fn("Slack.notes.post")(function* (
  ref: ThreadRef,
  text: string
): Effect.fn.Return<void, never, SlackClient> {
  const reply = yield* makeMessageReply(ref);
  yield* reply.reply(text).pipe(bestEffort);
});

/**
 * Show the native indicator the moment the message lands.
 *
 * Before the session lookup, before the prompt is even
 * assembled — all of which take seconds a reader spends looking at nothing.
 *
 * The only indicator the surface sets. Once the agent is running it says what
 * it is doing itself, through `slack-status`.
 */
export const startStatus = Effect.fn("Slack.notes.startStatus")(function* (
  ref: ThreadRef
): Effect.fn.Return<void, never, AssistantThreads> {
  const threads = yield* AssistantThreads;
  yield* threads.setStatus(
    {
      channelId: ref.channelId,
      threadTs: ref.threadTs,
    },
    "is starting up…",
    ["is starting up…"]
  );
});

/**
 * Say that a turn died before it could answer.
 *
 * A failure between the Slack event and the worker — fetching attachments,
 * reading thread history, assembling the prompt — was caught and LOGGED, and
 * the thread got nothing at all. Silence is the one outcome a reader cannot
 * act on: they cannot tell it from slow, so they wait.
 */
export const sayFailed = Effect.fn("Slack.notes.sayFailed")(function* (
  ref: ThreadRef
): Effect.fn.Return<void, never, SlackClient> {
  yield* postNote(
    ref,
    "_I hit an error before I could start on that — nothing ran. Worth asking again._"
  );
});

/** Told only when the caller actually has to wait, so it is never noise. */
export const postQueuedNotice = Effect.fn("Slack.notes.postQueuedNotice")(
  function* (ref: ThreadRef): Effect.fn.Return<void, never, SlackClient> {
    yield* postNote(
      ref,
      "_Queued — starting once the current run in this thread finishes._"
    );
  }
);

/**
 * The engagement decision, bound to the live store.
 *
 * `botUserId` prefers the resolved identity: an unset `SLACK_BOT_USER_ID` would
 * silently degrade the crowd tally to counting no bots at all.
 *
 * There is no edge left here. `EngagementDeps` is declared in Effect terms, so
 * the three I/O members hand back effects the decision yields: the store's two
 * need nothing further, and `postNote` gets the graph it asks for from the
 * context this was built with. That is one `runPromiseWith` gone — it existed
 * only because each `runPromise` started a fresh fiber with no context, which
 * cost the caller's spans and its interruption both.
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
    note: (ref, text) =>
      postNote(ref, text).pipe(Effect.provide(input.context)),
    stop: (key) => {
      cancelThread(key);
    },
    readListen: (key) => store.getListen(key),
    updateListen: (key, change) => store.updateListen(key, change),
  };
};
