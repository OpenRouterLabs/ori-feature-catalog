import { Context, Effect } from "effect";

import { bestEffort } from "./helpers/best-effort.ts";

import type { SlackConfig } from "./config.ts";
import type { SlackServices } from "./layers.ts";
import type { ThreadRef } from "./thread/thread.ts";
import type { EngagementDeps } from "./turn/listening/engagement.ts";

import type { SlackClient } from "./client/client.ts";
import { makeMessageReply } from "#src/message-reply/index.ts";
import { StateStore } from "./state/store.ts";
import { AssistantThreads } from "./thread/assistant.ts";
import { cancelThread } from "./thread/registry.ts";
import { gateContextOf } from "./turn/listening/gates.ts";

const postNote = Effect.fn("Slack.notes.post")(function* (
  ref: ThreadRef,
  text: string
): Effect.fn.Return<void, never, SlackClient> {
  const reply = yield* makeMessageReply(ref);
  yield* reply.reply(text).pipe(bestEffort);
});

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

export const sayFailed = Effect.fn("Slack.notes.sayFailed")(function* (
  ref: ThreadRef
): Effect.fn.Return<void, never, SlackClient> {
  yield* postNote(
    ref,
    "_I hit an error before I could start on that — nothing ran. Worth asking again._"
  );
});

export const postQueuedNotice = Effect.fn("Slack.notes.postQueuedNotice")(
  function* (ref: ThreadRef): Effect.fn.Return<void, never, SlackClient> {
    yield* postNote(
      ref,
      "_Queued — starting once the current run in this thread finishes._"
    );
  }
);

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
