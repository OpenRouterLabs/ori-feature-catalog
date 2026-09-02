import type { StateStore as OriStateStore } from "ori";

import { Layer, Schema } from "effect";

import { type ClientServices, SlackClientLayer } from "./client/index.ts";
import {
  type InteractionServices,
  InteractionsLayer,
} from "./interactions/index.ts";
import {
  MessageStreamLayer,
  type MessageStreamServices,
} from "./message-stream/index.ts";
import { opaqueSchema } from "./schema-support.ts";
import { StateLayer, type StateServices } from "./state/index.ts";
import { ThreadLayer, type ThreadServices } from "./thread/index.ts";

export type SlackServices =
  | ClientServices
  | InteractionServices
  | MessageStreamServices
  | StateServices
  | ThreadServices;

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
    ThreadLayer,
    MessageStreamLayer,
    StateLayer(input.store),
    InteractionsLayer
  ).pipe(Layer.provideMerge(SlackClientLayer(input.token)));
