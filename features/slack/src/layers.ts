import type { StateStore as OriStateStore } from "ori";

import { Layer, Schema } from "effect";

import { type ClientServices, makeSlackClientLayer } from "./client/index.ts";
import {
  type InteractionServices,
  interactionsLayer,
} from "./interactions/index.ts";
import {
  messageStreamLayer,
  type MessageStreamServices,
} from "./message-stream/index.ts";
import { opaqueSchema } from "./schema-support.ts";
import { makeStateLayer, type StateServices } from "./state/index.ts";
import { threadLayer, type ThreadServices } from "./thread/index.ts";

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
    threadLayer,
    messageStreamLayer,
    makeStateLayer({ store: input.store }),
    interactionsLayer
  ).pipe(Layer.provideMerge(makeSlackClientLayer({ token: input.token })));
