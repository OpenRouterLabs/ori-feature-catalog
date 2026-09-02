import type { StateStore as OriStateStore } from "ori";

import { Layer } from "effect";

import { makeSlackClientFromToken, SlackClient } from "./client/index.ts";
import { Blockers, BlockersMemory } from "./interactions/blocker.ts";
import { Interactions, makeInteractions } from "./interactions/interactions.ts";
import {
  Questionnaires,
  QuestionnairesMemory,
} from "./interactions/questionnaires.ts";
import { MessageStream, MessageStreamLive } from "./message-stream/stream.ts";
import { StateStoreDurable } from "./state/store-durable.ts";
import { StateStore, StateStoreMemory } from "./state/store.ts";
import { AssistantThreads, AssistantThreadsLive } from "./thread/assistant.ts";
import { ThreadContext, ThreadContextLive } from "./thread/thread.ts";

export type SlackServices =
  | AssistantThreads
  | Blockers
  | Interactions
  | MessageStream
  | Questionnaires
  | SlackClient
  | StateStore
  | ThreadContext;

const SlackClientLayer = (
  token: string,
  env: Readonly<Record<string, string | undefined>>
): Layer.Layer<SlackClient> =>
  Layer.sync(SlackClient)(() =>
    SlackClient.of(makeSlackClientFromToken(token, env))
  );

interface SlackGraphInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly store?: OriStateStore | undefined;
  readonly token: string;
}

export const SlackDefaultLayers = (
  input: SlackGraphInput
): Layer.Layer<SlackServices> =>
  Layer.mergeAll(
    Layer.effect(ThreadContext)(ThreadContextLive),
    Layer.succeed(MessageStream)(MessageStreamLive),
    Layer.effect(StateStore)(
      input.store === undefined
        ? StateStoreMemory
        : StateStoreDurable(input.store)
    ),
    Layer.effect(Questionnaires)(QuestionnairesMemory),
    Layer.effect(Blockers)(BlockersMemory),
    Layer.sync(Interactions)(makeInteractions),
    Layer.effect(AssistantThreads)(AssistantThreadsLive())
  ).pipe(Layer.provideMerge(SlackClientLayer(input.token, input.env)));
