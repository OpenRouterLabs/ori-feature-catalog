import { Predicate } from "effect";

const OOM_FIRST_SCORE = "1000";

const PROC_ROOT = "/proc";

const SHELL = "/bin/sh";

const MARK_SELF_THEN_EXEC = `echo ${OOM_FIRST_SCORE} > /proc/self/oom_score_adj 2>/dev/null; exec "$0" "$@"`;

export interface ExecutableLookup {
  readonly cwd?: string | undefined;
  readonly path?: string | undefined;
}

const resolvesExecutable = (
  command: string,
  lookup: ExecutableLookup
): boolean => {
  const options: Bun.WhichOptions = {};
  if (Predicate.isNotUndefined(lookup.cwd)) {
    options.cwd = lookup.cwd;
  }
  if (Predicate.isNotUndefined(lookup.path)) {
    options.PATH = lookup.path;
  }
  return Predicate.isNotNull(Bun.which(command, options));
};

export const oomFirstArgv = (
  argv: readonly string[],
  lookup: ExecutableLookup = {},
  platform: string = process.platform
): string[] => {
  const [command] = argv;
  return platform === "linux" &&
    Predicate.isNotUndefined(command) &&
    resolvesExecutable(command, lookup)
    ? [SHELL, "-c", MARK_SELF_THEN_EXEC, ...argv]
    : [...argv];
};

const oomScoreAdjPath = (pid: number, procRoot: string = PROC_ROOT) =>
  `${procRoot}/${pid}/oom_score_adj`;

const preferOomKill = (
  pid: number,
  procRoot: string = PROC_ROOT
): Promise<boolean> =>
  Bun.write(oomScoreAdjPath(pid, procRoot), OOM_FIRST_SCORE, {
    createPath: false,
  }).then(
    () => true,
    () => false
  );

export const markOomFirst = async <Child extends { readonly pid: number }>(
  child: Child
): Promise<Child> => {
  await preferOomKill(child.pid);
  return child;
};
