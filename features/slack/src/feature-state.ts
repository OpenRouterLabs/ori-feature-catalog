import type { SlackRuntime } from "./index.ts";
import type { SlackButtonHandler } from "./interactions/custom.ts";

const KEY = Symbol.for("ori.slack.feature-state");

export interface SlackFeatureState {
  readonly buttons: Map<string, SlackButtonHandler>;
  runtime: SlackRuntime | undefined;
}

type StateHolder = { [KEY]?: SlackFeatureState };

export const featureState = (): SlackFeatureState => {
  const holder = globalThis as StateHolder;
  holder[KEY] ??= {
    buttons: new Map<string, SlackButtonHandler>(),
    runtime: undefined,
  };
  return holder[KEY];
};
