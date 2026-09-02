import { Layer } from "effect";

import { MessageStream, MessageStreamLive } from "./stream.ts";

export type MessageStreamServices = MessageStream;

export const MessageStreamLayer: Layer.Layer<MessageStreamServices> =
  Layer.succeed(MessageStream)(MessageStreamLive);

export * from "./answer-text.ts";
export * from "./run-state.ts";
export * from "./settle.ts";
export * from "./stream.ts";
export * from "./tool-liveness.ts";
