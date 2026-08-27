/**
 * layers.ts — the feature's service graph, as Layers.
 *
 * Why Layers and not a bag of constructed values: a value can be replaced only
 * by whoever constructs it, but a Layer can be WRAPPED by anyone who can see
 * the tag. That is the whole extensibility story in the RFC — a downstream
 * feature supplies a layer that both requires and provides the same tag,
 * receives ours as its parent, and delegates to it.
 *
 * `SlackClient` is composed in with `provideMerge` rather than `provide`: it is
 * both an input to the services above it AND part of the graph's output, so a
 * downstream layer can wrap the client itself, not just the services built on
 * it.
 */

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

/** Everything the turn path needs. This is the published surface. */
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

/** What the graph needs that is not a service. */
interface SlackGraphInput {
  /**
   * The framework's state store, when the host injected one.
   *
   * Absent for a lightweight `Chat` mock and in a client process without one,
   * where the memory store is the honest fallback: a cold start per restart,
   * which is what every restart cost before this existed.
   */
  readonly store?: OriStateStore | undefined;
  readonly token: string;
}

/** The default graph. Overrides compose over this — see `extend.ts`. */
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
