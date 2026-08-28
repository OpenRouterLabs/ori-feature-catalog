/**
 * index.ts — what the rest of the surface uses to remember a thread.
 *
 * `store-durable.ts` is absent on purpose: the only caller that picks an
 * implementation is `layers.ts`, which imports it by path. Everything else
 * wants the service and its shapes, not the choice between them.
 */

export {
  DEFAULT_INTERRUPT_MODE,
  InterruptMode,
  interruptModeFrom,
} from "./settings.ts";
export type {
  StateStoreShape,
  ThreadRow,
  ThreadSession,
} from "./store.ts";
export { StateStore, StateStoreMemory } from "./store.ts";
