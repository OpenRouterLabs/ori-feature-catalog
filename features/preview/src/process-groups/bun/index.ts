import { Effect, Layer, Option } from "effect";

import { PreviewError } from "#src/errors.ts";
import {
  type DetachedSpawn,
  ProcessGroups,
  type ProcessGroupsShape,
} from "#src/process-groups/index.ts";
import { markOomFirst, oomFirstArgv } from "#src/oom-first-child.ts";

const sendSignal = (pid: number, signal: NodeJS.Signals | 0): boolean =>
  Option.isSome(
    Option.liftThrowable(() => globalThis.process.kill(pid, signal))()
  );

const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
  if (!sendSignal(-pid, signal)) {
    sendSignal(pid, signal);
  }
};

const killOnAbort = (pid: number, signal: AbortSignal): void => {
  signal.addEventListener(
    "abort",
    () => {
      signalGroup(pid, "SIGKILL");
    },
    { once: true }
  );
};

const spawnGroup = (input: DetachedSpawn) =>
  markOomFirst(
    Bun.spawn(
      oomFirstArgv(input.command, {
        cwd: input.cwd,
        path: input.env["PATH"],
      }),
      {
        cwd: input.cwd,
        detached: true,
        env: input.env,
        stderr: Bun.file(input.logPath),
        stdin: "ignore",
        stdout: Bun.file(input.logPath),
      }
    )
  );

export const bunProcessGroups: ProcessGroupsShape = {
  spawnDetached: (input) =>
    Effect.tryPromise({
      try: () => spawnGroup(input),
      catch: () =>
        new PreviewError({
          code: "start_failed",
          detail: `Could not start ${input.command.join(" ")} in ${input.cwd}.`,
        }),
    }).pipe(
      Effect.map((child) => {
        child.unref();
        return child.pid;
      })
    ),
  runToExit: (input) =>
    Effect.tryPromise({
      try: async (signal) => {
        const child = await spawnGroup(input);
        killOnAbort(child.pid, signal);
        return child.exited;
      },
      catch: () =>
        new PreviewError({
          code: "install_failed",
          detail: `Could not run ${input.command.join(" ")} in ${input.cwd}.`,
        }),
    }),
  signal: (pid, signal) => Effect.sync(() => sendSignal(pid, signal)),
  ownPid: Effect.sync(() => globalThis.process.pid),
};

export const bunProcessGroupsLayer =
  Layer.succeed(ProcessGroups)(bunProcessGroups);
