/**
 * index.ts — a thread's identity, its pane, and the queue of turns on it.
 *
 * `registry-test-support.ts` is absent for the same reason `client/` leaves
 * its fake out: tests import it by path, and it has no place in the
 * production surface.
 */

export type { AssistantThreadsShape, PaneContext } from "./assistant.ts";
export {
  AssistantThreads,
  AssistantThreadsLive,
  keyOf,
  titleFromMessage,
} from "./assistant.ts";
export type { LiveTurn } from "./registry.ts";
export {
  cancelAll,
  cancelThread,
  cancelTurn,
  drain,
  enqueue,
  hasSuccessor,
  isBusy,
  resetRegistry,
  steerThread,
  threadCount,
  TURN_STEER_REASON,
  TURN_TIMEOUT_REASON,
} from "./registry.ts";
export type { ThreadRef } from "./thread.ts";
export {
  parseThreadInstanceId,
  sanitizeThreadContent,
  ThreadContext,
  ThreadContextLive,
  threadInstanceId,
} from "./thread.ts";
