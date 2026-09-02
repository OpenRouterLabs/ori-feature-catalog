import { type RunState, withTool } from "./run-state.ts";


export const startedTool = (state: RunState, tool: string): RunState => ({
  ...withTool(state, tool),
  openTools: state.openTools + 1,
});

export const finishedTool = (state: RunState): RunState => ({
  ...state,
  alive: state.alive + 1,
  openTools: Math.max(0, state.openTools - 1),
});

export const workingTool = (state: RunState): RunState => ({
  ...state,
  alive: state.alive + 1,
});
