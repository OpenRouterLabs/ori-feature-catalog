/**
 * spawn-thread.ts — pure argument parsing and loopback dispatch logic for the
 * spawn-thread skill. The shebanged CLI entry (./index.ts) stays a thin shell
 * over these exports, and the `new`-subcommand workflow (anchor + opener
 * posts) lives in ./run-new.ts; everything here is side-effect free apart
 * from the injected fetch seam, so tests drive it directly.
 *
 * Calls the agent's dispatch endpoint POST /slack/thread/dispatch — served by the
 * ori daemon from the slack feature's api.routes (RFC 0002 api.md). The
 * runloop owns the full message pipeline for the target thread — the
 * "is thinking…" status, the agent run, the See-details reply — exactly as if
 * a user had @mentioned the bot there.
 *
 * The route's in-handler guard rejects any non-loopback caller, so only
 * processes on the same VM (this skill) can reach it regardless of the
 * daemon's bind address. There is no auth layer: loopback IS the boundary.
 *
 * Two subcommands cover the two real workflows:
 *   new      — open a fresh top-level thread + dispatch atomically.
 *   continue — dispatch into an already-open thread.
 * A flag-only legacy form (no subcommand) is preserved and treated as
 * `continue`.
 */

import { Result } from "effect";

import { tryCatchAsync } from "#skills/slack-api/scripts/result.ts";

// The daemon's default port (framework/runloop daemon-http-defaults.ts, 3141):
// /slack/thread/dispatch is served by the daemon via the slack feature's api routes
// (RFC 0002 api.md), not by a private slack HTTP server.
export const DEFAULT_HTTP_PORT = 3141;
const MAX_PORT = 65_535;
// Must equal the dispatch route's MAX_SPAWN_DEPTH (interactions/dispatch.ts).
// This script runs inside the materialized feature dir via relative imports,
// so the pair cannot share one module; the spawn-depth parity test pins them
// (and the off-by-one contract between checkDepth and the accepting schema).
export const MAX_SPAWN_DEPTH = 3;

export const Subcommand = {
  New: "new",
  Continue: "continue",
} as const;
export type Subcommand = (typeof Subcommand)[keyof typeof Subcommand];

export interface ParsedArgs {
  subcommand?: Subcommand;
  channel?: string;
  threadTs?: string;
  prompt?: string;
  opener?: string;
}

/**
 * Minimal fetch shape the dispatch call needs. Injecting this (rather than
 * `typeof fetch`, which also carries Bun's static members) lets tests supply a
 * plain closure without unsafe casts.
 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

const readSubcommand = (argv: readonly string[]): Subcommand | undefined => {
  const [first] = argv;
  return first === Subcommand.New || first === Subcommand.Continue
    ? first
    : undefined;
};

const hasFlagValue = (argv: readonly string[], index: number): boolean => {
  const next = argv[index + 1];
  return Boolean(next) && !next.startsWith("-");
};

/**
 * Match a `--flag value` (or short-alias) pair at `index`. Returns the value
 * and the index of the consumed value token, or undefined when the token is
 * not this flag (or the flag has no usable value).
 */
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

/** Whether the token at `index` is one of `names` with at least one token after it. */
const isRestFlag = (
  argv: readonly string[],
  index: number,
  names: readonly string[]
): boolean => names.includes(argv[index]) && index + 1 < argv.length;

/**
 * Consume tokens after --opener/-o until the next --prompt/-p flag (so
 * `--opener X --prompt Y` works). Returns the joined opener text and the loop
 * index to resume from.
 */
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

// --prompt is terminal: it consumes ALL remaining tokens (and must come after
// --opener when both are used), signalled by returning past the end of argv.
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
  // `Number()` (not `parseInt`) so partially-numeric values like "2abc" return
  // NaN instead of silently parsing as 2.
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

/**
 * Resolve the daemon HTTP port serving /slack/thread/dispatch. The route lives on
 * the ori daemon (the slack feature's `api.routes`, RFC 0002 api.md), so this
 * mirrors the daemon's own `ORI_RUNTIME_PORT` (default 3141). The skill POSTs
 * to http://127.0.0.1:$port/slack/thread/dispatch; the route's in-handler loopback
 * guard keeps it same-VM only regardless of the daemon's bind address.
 */
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

export interface DispatchOpts {
  channel: string;
  threadTs: string;
  message: string;
  depth: number;
  env: Record<string, string | undefined>;
  fetchImpl?: FetchLike | undefined;
}

/**
 * POST to the agent's loopback /slack/thread/dispatch endpoint. The endpoint
 * enqueues a turn on the target thread's serial queue and returns immediately;
 * this skill does not wait for the agent run. Loopback (127.0.0.1) is the
 * trust boundary — there is no auth header.
 */
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

export interface RunContinueOpts {
  channel: string;
  threadTs: string;
  prompt: string;
  depth: number;
  env: Record<string, string | undefined>;
  fetchImpl?: FetchLike | undefined;
}

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
