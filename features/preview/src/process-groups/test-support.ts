import { Effect, Layer } from "effect";

import {
  type DetachedSpawn,
  ProcessGroups,
  type ProcessGroupsShape,
} from "./index.ts";

export interface ProcessGroupsRecording {
  readonly spawned: DetachedSpawn[];
  readonly ran: DetachedSpawn[];
  readonly signals: {
    readonly pid: number;
    readonly signal: NodeJS.Signals | 0;
  }[];
}

export const emptyProcessGroupsRecording = (): ProcessGroupsRecording => ({
  ran: [],
  signals: [],
  spawned: [],
});

export interface ProcessGroupsScript {
  readonly ownPid?: number;
  readonly spawnedPid?: number;
  readonly exitCode?: number;
  readonly alive?: (pid: number) => boolean;
}

export const recordingProcessGroupsLayer = (
  recording: ProcessGroupsRecording = emptyProcessGroupsRecording(),
  script: ProcessGroupsScript = {}
): Layer.Layer<ProcessGroups> => {
  const shape: ProcessGroupsShape = {
    spawnDetached: (input) =>
      Effect.sync(() => {
        recording.spawned.push(input);
        return script.spawnedPid ?? 0;
      }),
    runToExit: (input) =>
      Effect.sync(() => {
        recording.ran.push(input);
        return script.exitCode ?? 0;
      }),
    signal: (pid, signal) =>
      Effect.sync(() => {
        recording.signals.push({ pid, signal });
        return script.alive?.(pid) ?? false;
      }),
    ownPid: Effect.succeed(script.ownPid ?? 1),
  };
  return Layer.succeed(ProcessGroups)(shape);
};
