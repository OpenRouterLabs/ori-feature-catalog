import { Layer } from "effect";

import { MessageStream, MessageStreamLive } from "./stream.ts";

export type MessageStreamServices = MessageStream;

const messageStreamImplementationLayer: Layer.Layer<MessageStreamServices> =
  Layer.succeed(MessageStream)(MessageStreamLive);

export const makeMessageStreamLayer = (): Layer.Layer<MessageStreamServices> =>
  messageStreamImplementationLayer;

export const messageStreamLayer = makeMessageStreamLayer();
