import { Layer } from "effect";

import type { SlackClient } from "#src/client/client.ts";

import { AssistantThreads, AssistantThreadsLive } from "./assistant.ts";
import { ThreadContext, ThreadContextLive } from "./thread.ts";

export type ThreadServices = AssistantThreads | ThreadContext;

const threadImplementationLayer: Layer.Layer<ThreadServices, never, SlackClient> =
  Layer.mergeAll(
    Layer.effect(ThreadContext)(ThreadContextLive),
    Layer.effect(AssistantThreads)(AssistantThreadsLive())
  );

export const makeThreadLayer = (): Layer.Layer<ThreadServices, never, SlackClient> =>
  threadImplementationLayer;

export const threadLayer = makeThreadLayer();
