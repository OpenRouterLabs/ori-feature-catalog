import { Result, Schema } from "effect";

import { functionSchema } from "#src/schema-support.ts";
import { tryCatchAsync } from "#skills/slack-api/scripts/result.ts";

export const DEFAULT_HTTP_PORT = 3141;
const MAX_PORT = 65_535;
export const MAX_SPAWN_DEPTH = 3;

export const Subcommand = {
  Continue: "continue",
  Fork: "fork",
  New: "new",
} as const;
export type Subcommand = (typeof Subcommand)[keyof typeof Subcommand];

const ParsedArgsSchema = Schema.Struct({
  subcommand: Schema.mutableKey(
    Schema.optionalKey(
      Schema.Literals([Subcommand.Continue, Subcommand.Fork, Subcommand.New])
    )
  ),
  channel: Schema.mutableKey(Schema.optionalKey(Schema.String)),
  threadTs: Schema.mutableKey(Schema.optionalKey(Schema.String)),
  prompt: Schema.mutableKey(Schema.optionalKey(Schema.String)),
  opener: Schema.mutableKey(Schema.optionalKey(Schema.String)),
});

type ParsedArgs = typeof ParsedArgsSchema.Type;

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

const readSubcommand = (argv: readonly string[]): Subcommand | undefined => {
  const [first] = argv;
  return first === Subcommand.New ||
    first === Subcommand.Continue ||
    first === Subcommand.Fork
    ? first
    : undefined;
};

const hasFlagValue = (argv: readonly string[], index: number): boolean => {
  const next = argv[index + 1];
  return Boolean(next) && !next.startsWith("-");
};

const readValueFlag = (
  argv: readonly string[],
  index: number,
  names: readonly string[]
): { readonly value: string; readonly nextIndex: number } | undefined => {
  if (!names.includes(argv[index]) || !hasFlagValue(argv, index)) {
    return undefined;
  }
  return {
    value: argv[index + 1],
    nextIndex: index + 1,
  };
};

const isRestFlag = (
  argv: readonly string[],
  index: number,
  names: readonly string[]
): boolean => names.includes(argv[index]) && index + 1 < argv.length;

const consumeOpener = (
  argv: readonly string[],
  flagIndex: number
): { readonly value: string; readonly nextIndex: number } => {
  const tokens: string[] = [];
  let j = flagIndex + 1;
  while (j < argv.length && argv[j] !== "--prompt" && argv[j] !== "-p") {
    tokens.push(argv[j]);
    j += 1;
  }
  return {
    value: tokens.join(" "),
    nextIndex: j - 1,
  };
};

const consumeFlagAt = (
  argv: string[],
  i: number,
  result: ParsedArgs
): number | undefined => {
  const channel = readValueFlag(argv, i, ["--channel", "-c"]);
  if (channel) {
    result.channel = channel.value;
    return channel.nextIndex;
  }
  const threadTs = readValueFlag(argv, i, ["--thread-ts", "-t"]);
  if (threadTs) {
    result.threadTs = threadTs.value;
    return threadTs.nextIndex;
  }
  if (isRestFlag(argv, i, ["--opener", "-o"])) {
    const opener = consumeOpener(argv, i);
    result.opener = opener.value;
    return opener.nextIndex;
  }
  if (isRestFlag(argv, i, ["--prompt", "-p"])) {
    result.prompt = argv.slice(i + 1).join(" ");
    return argv.length;
  }
  return undefined;
};

export const parseArgs = (argv: string[]): ParsedArgs => {
  const result: ParsedArgs = {};
  const subcommand = readSubcommand(argv);
  let start = 0;
  if (subcommand) {
    result.subcommand = subcommand;
    start = 1;
  }

  const positional: string[] = [];

  for (let i = start; i < argv.length; i += 1) {
    const resumeIndex = consumeFlagAt(argv, i, result);
    if (resumeIndex !== undefined) {
      i = resumeIndex;
      continue;
    }
    positional.push(argv[i]);
  }

  if (!result.prompt && positional.length > 0) {
    result.prompt = positional.join(" ");
  }

  return result;
};

export const checkDepth = (envValue?: string): Result.Result<number, Error> => {
  const depth = Number(envValue ?? "0");
  if (
    Number.isNaN(depth) ||
    !Number.isInteger(depth) ||
    depth < 0 ||
    depth >= MAX_SPAWN_DEPTH
  ) {
    return Result.fail(
      new Error(
        `spawn-thread: max depth (${MAX_SPAWN_DEPTH}) reached — refusing to recurse further`
      )
    );
  }
  return Result.succeed(depth);
};

export const resolveHttpPort = (
  env: Record<string, string | undefined>
): number => {
  const raw = env.ORI_RUNTIME_PORT;
  if (!raw) {
    return DEFAULT_HTTP_PORT;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_PORT
    ? parsed
    : DEFAULT_HTTP_PORT;
};

const DispatchOptsSchema = Schema.Struct({
  channel: Schema.mutableKey(Schema.String),
  threadTs: Schema.mutableKey(Schema.String),
  message: Schema.mutableKey(Schema.String),
  depth: Schema.mutableKey(Schema.Number),
  env: Schema.mutableKey(
    Schema.Record(
      Schema.String,
      Schema.mutableKey(Schema.UndefinedOr(Schema.String))
    )
  ),
  fetchImpl: Schema.mutableKey(
    Schema.optionalKey(
      Schema.UndefinedOr(functionSchema<FetchLike>("DispatchOpts.fetchImpl"))
    )
  ),
});

type DispatchOpts = typeof DispatchOptsSchema.Type;

export const dispatchToRunloop = async (
  opts: DispatchOpts
): Promise<Result.Result<void, Error>> => {
  const port = resolveHttpPort(opts.env);
  const dispatchUrl = `http://127.0.0.1:${port}/slack/thread/dispatch`;
  const fetchFn = opts.fetchImpl ?? fetch;

  const fetchResult = await tryCatchAsync(() =>
    fetchFn(dispatchUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: opts.channel,
        thread_ts: opts.threadTs,
        message: opts.message,
        user_id: opts.env.SLACK_USER_ID,
        spawn_thread_depth: opts.depth + 1,
      }),
    })
  );

  if (Result.isFailure(fetchResult)) {
    return Result.fail(
      new Error(`dispatch request failed: ${fetchResult.failure.message}`)
    );
  }

  const response = fetchResult.success;
  if (!response.ok) {
    const bodyResult = await tryCatchAsync(() => response.text());
    const errorMsg = Result.isSuccess(bodyResult)
      ? bodyResult.success
      : "could not read error body";
    return Result.fail(
      new Error(`dispatch rejected (HTTP ${response.status}): ${errorMsg}`)
    );
  }

  return Result.void;
};

const RunContinueOptsSchema = Schema.Struct({
  channel: Schema.mutableKey(Schema.String),
  threadTs: Schema.mutableKey(Schema.String),
  prompt: Schema.mutableKey(Schema.String),
  depth: Schema.mutableKey(Schema.Number),
  env: Schema.mutableKey(
    Schema.Record(
      Schema.String,
      Schema.mutableKey(Schema.UndefinedOr(Schema.String))
    )
  ),
  fetchImpl: Schema.mutableKey(
    Schema.optionalKey(
      Schema.UndefinedOr(functionSchema<FetchLike>("RunContinueOpts.fetchImpl"))
    )
  ),
});

type RunContinueOpts = typeof RunContinueOptsSchema.Type;

export const runContinue = async (
  opts: RunContinueOpts
): Promise<Result.Result<void, Error>> =>
  await dispatchToRunloop({
    channel: opts.channel,
    threadTs: opts.threadTs,
    message: opts.prompt,
    depth: opts.depth,
    env: opts.env,
    fetchImpl: opts.fetchImpl,
  });