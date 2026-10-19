import { Effect, FileSystem, Option, Predicate } from "effect";

import { PreviewError } from "../errors.ts";
import {
  type DetachedSpawn,
  ProcessGroups,
} from "../process-groups/index.ts";
import { TcpProbe } from "../tcp-probe/index.ts";

export interface ProcessRef {
  readonly pid: number;
  readonly startedAt?: string | undefined;
}

const SHELL = "/bin/sh";

const STAT_START_FIELD = 19;

export const shellCommand = (script: string): readonly string[] => [
  SHELL,
  "-c",
  script,
];

const parentDirectory = (path: string): string =>
  path.slice(0, path.lastIndexOf("/"));

export const parseStartTime = (stat: string): Option.Option<string> =>
  Option.fromNullishOr(
    stat.slice(stat.lastIndexOf(")") + 2).split(" ")[STAT_START_FIELD]
  ).pipe(Option.filter((field) => /^\d+$/u.test(field)));

export const processStartTime = Effect.fn("Preview.process.startTime")(
  function* (pid: number) {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(`/proc/${pid}/stat`).pipe(
      Effect.map(parseStartTime),
      Effect.orElseSucceed(() => Option.none<string>())
    );
  }
);

export const spawnDetached = Effect.fn("Preview.process.spawnDetached")(
  function* (input: DetachedSpawn) {
    const fs = yield* FileSystem.FileSystem;
    const processGroups = yield* ProcessGroups;
    yield* fs.makeDirectory(parentDirectory(input.logPath), {
      recursive: true,
    });
    const pid = yield* processGroups.spawnDetached(input);
    const ref: ProcessRef = {
      pid,
      startedAt: Option.getOrUndefined(yield* processStartTime(pid)),
    };
    return ref;
  }
);

export const currentProcess = ProcessGroups.use(
  (processGroups) => processGroups.ownPid
).pipe(
  Effect.flatMap((pid) =>
    processStartTime(pid).pipe(
      Effect.map((started): ProcessRef => ({
        pid,
        startedAt: Option.getOrUndefined(started),
      }))
    )
  )
);

const isOwnProcess = Effect.fnUntraced(function* (pid: number) {
  const processGroups = yield* ProcessGroups;
  return pid === (yield* processGroups.ownPid) || pid <= 1;
});

const sendSignal = (pid: number, signal: NodeJS.Signals | 0) =>
  ProcessGroups.use((processGroups) => processGroups.signal(pid, signal));

export const isAlive = Effect.fn("Preview.process.isAlive")(function* (
  ref: ProcessRef | undefined
) {
  if (Predicate.isUndefined(ref) || (yield* isOwnProcess(ref.pid))) {
    return false;
  }
  if (!(yield* sendSignal(ref.pid, 0))) {
    return false;
  }
  if (Predicate.isUndefined(ref.startedAt)) {
    return true;
  }
  return Option.contains(yield* processStartTime(ref.pid), ref.startedAt);
});

const STOP_GRACE_POLLS = 50;

const STOP_POLL = "100 millis";

const signalGroup = Effect.fnUntraced(function* (
  pid: number,
  signal: NodeJS.Signals
) {
  if (!(yield* sendSignal(-pid, signal))) {
    yield* sendSignal(pid, signal);
  }
});

export const killGroup = Effect.fn("Preview.process.killGroup")(function* (
  ref: ProcessRef | undefined
) {
  if (Predicate.isUndefined(ref) || !(yield* isAlive(ref))) {
    return;
  }
  yield* signalGroup(ref.pid, "SIGTERM");
  const stillAlive = yield* isAlive(ref).pipe(
    Effect.delay(STOP_POLL),
    Effect.repeat({ until: (alive) => !alive, times: STOP_GRACE_POLLS })
  );
  if (stillAlive) {
    yield* signalGroup(ref.pid, "SIGKILL");
  }
});

export const runToLog = Effect.fn("Preview.process.runToLog")(function* (
  input: DetachedSpawn
) {
  const fs = yield* FileSystem.FileSystem;
  const processGroups = yield* ProcessGroups;
  yield* fs.makeDirectory(parentDirectory(input.logPath), { recursive: true });
  return yield* processGroups.runToExit(input);
});

export const tailLog = Effect.fn("Preview.process.tailLog")(function* (
  path: string,
  lines = 40
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(path)
    .pipe(Effect.orElseSucceed(() => ""));
  return text.trimEnd().split("\n").slice(-lines).join("\n");
});

export const assignPort = Effect.fn("Preview.process.assignPort")(function* (
  range: { readonly first: number; readonly last: number },
  claimed: ReadonlySet<number>
) {
  const candidates = Array.from(
    { length: range.last - range.first + 1 },
    (_, offset) => range.first + offset
  );
  const tcpProbe = yield* TcpProbe;
  const port = yield* Effect.findFirst(candidates, (candidate) =>
    claimed.has(candidate)
      ? Effect.succeed(false)
      : tcpProbe.isPortFree(candidate)
  );
  if (Option.isNone(port)) {
    return yield* new PreviewError({
      code: "start_failed",
      detail: `No free preview port is left between ${range.first} and ${range.last}.`,
    });
  }
  return port.value;
});

export const ensurePortFree = Effect.fn("Preview.process.ensurePortFree")(
  function* (port: number) {
    const tcpProbe = yield* TcpProbe;
    if (!(yield* tcpProbe.isPortFree(port))) {
      return yield* new PreviewError({
        code: "start_failed",
        detail: `Port ${port} is already in use, so a new server there could not be told apart from what is already listening.`,
      });
    }
  }
);
