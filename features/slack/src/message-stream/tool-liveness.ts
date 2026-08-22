/**
 * tool-liveness.ts — what a tool event means for whether a run is alive.
 *
 * None of these shows anything in the thread, which is exactly why they are
 * here rather than in the rendering path. They exist so the watchdogs can tell
 * a run doing slow work from a run that has died — the runtime log has a pi
 * run emitting nothing between `tool.started` and `tool.succeeded` for
 * forty-two minutes, twice, and both clocks killed it.
 */

import type { RunState } from "./run-state.ts";

import { withTool } from "./run-state.ts";

/** A tool is now in flight, so the run counts as working until it finishes. */
export const startedTool = (state: RunState, tool: string): RunState => ({
  ...withTool(state, tool),
  openTools: state.openTools + 1,
});

/**
 * A tool finished. Floored at zero because the surface joins a run mid-stream
 * on a reconnect, and a completion whose start it never saw must not go
 * negative and read as "working" forever.
 */
export const finishedTool = (state: RunState): RunState => ({
  ...state,
  alive: state.alive + 1,
  openTools: Math.max(0, state.openTools - 1),
});

/** Output or progress from a tool still running: proof of life, nothing more. */
export const workingTool = (state: RunState): RunState => ({
  ...state,
  alive: state.alive + 1,
});
