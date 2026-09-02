import type { StateStore as OriStateStore } from "ori";

import { Layer, Schema } from "effect";

import { makeSlackClientFromToken, SlackClient } from "./client/index.ts";
import { Blockers, BlockersMemory } from "./interactions/blocker.ts";
import { Interactions, makeInteractions } from "./interactions/interactions.ts";
import {
  Questionnaires,
  QuestionnairesMemory,
} from "./interactions/questionnaires.ts";
import { MessageStream, MessageStreamLive } from "./message-stream/stream.ts";
import { opaqueSchema } from "./schema-support.ts";
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

const SlackClientLayer = (token: string): Layer.Layer<SlackClient> =>
  Layer.sync(SlackClient)(() =>
    SlackClient.of(makeSlackClientFromToken(token))
  );

const SlackGraphInputSchema = Schema.Struct({
  store: Schema.optionalKey(
    Schema.UndefinedOr(opaqueSchema<OriStateStore>("SlackGraphInput.store"))
  ),
  token: Schema.String,
});

type SlackGraphInput = typeof SlackGraphInputSchema.Type;

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
  ).pipe(Layer.provideMerge(SlackClientLayer(input.token)));
