import { Layer } from "effect";

import { MessageStream, MessageStreamLive } from "./stream.ts";

export type MessageStreamServices = MessageStream;

export const MessageStreamLayer: Layer.Layer<MessageStreamServices> =
  Layer.succeed(MessageStream)(MessageStreamLive);
