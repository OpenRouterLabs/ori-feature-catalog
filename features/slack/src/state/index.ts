import type { StateStore as OriStateStore } from "ori";

import { Context, Effect, Layer, Schema } from "effect";

import { opaqueSchema } from "#src/schema-support.ts";

import { StateStoreDurable } from "./store-durable.ts";
import { StateStore, StateStoreMemory } from "./store.ts";

const StateLayerOptionsSchema = Schema.Struct({
  store: Schema.optionalKey(
    Schema.UndefinedOr(opaqueSchema<OriStateStore>("StateLayerOptions.store"))
  ),
});

type StateLayerOptions = typeof StateLayerOptionsSchema.Type;

class StateConfig extends Context.Service<StateConfig, StateLayerOptions>()(
  "ori/slack/StateConfig"
) {
  static readonly fromOptions = (
    options: StateLayerOptions
  ): Layer.Layer<StateConfig> =>
    Layer.effect(StateConfig)(Effect.succeed(StateConfig.of(options)));
}

export type StateServices = StateStore;

const stateImplementationLayer = Layer.effect(StateStore)(
  Effect.gen(function* () {
    const config = yield* StateConfig;
    return yield* config.store === undefined
      ? StateStoreMemory
      : StateStoreDurable(config.store);
  })
);

export const makeStateLayer = (
  options?: StateLayerOptions
): Layer.Layer<StateServices> =>
  stateImplementationLayer.pipe(
    Layer.provide(StateConfig.fromOptions({ store: options?.store }))
  );

export const stateLayer = makeStateLayer();

export type { StateLayerOptions };
