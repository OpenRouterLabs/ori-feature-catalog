import type { StateStore as OriStateStore } from "ori";

import { Layer } from "effect";

import { StateStoreDurable } from "./store-durable.ts";
import { StateStore, StateStoreMemory } from "./store.ts";

export type StateServices = StateStore;

export const StateLayer = (
  store: OriStateStore | undefined
): Layer.Layer<StateServices> =>
  Layer.effect(StateStore)(
    store === undefined ? StateStoreMemory : StateStoreDurable(store)
  );
