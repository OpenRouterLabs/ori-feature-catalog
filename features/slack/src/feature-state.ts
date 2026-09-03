import { Schema } from "effect";

import type { SlackRuntime } from "./index.ts";
import type { SlackButtonHandler } from "./interactions/custom.ts";

import { opaqueSchema } from "./schema-support.ts";

const KEY = Symbol.for("ori.slack.feature-state");

export const SlackFeatureStateSchema = Schema.Struct({
  buttons: opaqueSchema<Map<string, SlackButtonHandler>>(
    "SlackFeatureState.buttons"
  ),
  runtime: Schema.mutableKey(
    Schema.UndefinedOr(opaqueSchema<SlackRuntime>("SlackFeatureState.runtime"))
  ),
});

export type SlackFeatureState = typeof SlackFeatureStateSchema.Type;

type StateHolder = { [KEY]?: SlackFeatureState };

export const featureState = (): SlackFeatureState => {
  const holder = globalThis as StateHolder;
  holder[KEY] ??= {
    buttons: new Map<string, SlackButtonHandler>(),
    runtime: undefined,
  };
  return holder[KEY];
};
