import { Context, type Effect } from "effect";

import type { PreviewError } from "#src/errors.ts";

export interface DetachedSpawn {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logPath: string;
}

export interface ProcessGroupsShape {
  readonly spawnDetached: (
    input: DetachedSpawn
  ) => Effect.Effect<number, PreviewError>;
  readonly runToExit: (
    input: DetachedSpawn
  ) => Effect.Effect<number, PreviewError>;
  readonly signal: (
    pid: number,
    signal: NodeJS.Signals | 0
  ) => Effect.Effect<boolean>;
  readonly ownPid: Effect.Effect<number>;
}

export class ProcessGroups extends Context.Service<
  ProcessGroups,
  ProcessGroupsShape
>()("@ori-catalog/preview/process-groups/ProcessGroups") {}
