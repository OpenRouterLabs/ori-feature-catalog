/**
 * run-fork.ts — open several threads at once and put work in each.
 *
 * "Spin up 2 threads to talk about X with me" is one request, and answering it
 * by calling `new` twice made the two threads independent accidents: if the
 * second failed the user was told nothing, and the first was already live.
 *
 * Each thread still gets its own fresh session, exactly as `new` does — this
 * is the same operation, done N times with one report at the end.
 *
 * Sequential rather than concurrent, deliberately. Slack rate-limits per
 * channel, and the threads appear in the order the user named them, which is
 * the order they will refer to them in ("thread 1", "thread 2").
 */

import { Result } from "effect";

import type { FetchLike } from "./spawn-thread.ts";
import type { postMessage } from "./post-message.ts";
import type { SpawnedThread } from "./run-new.ts";
import type { updateMessage } from "./update-message.ts";

import { runNew } from "./run-new.ts";

/**
 * More threads than this is not a request, it is a channel being flooded. The
 * real asks are two or three.
 */
export const MAX_FORK = 5;

export interface ForkThread {
  /** The message that opens the thread — what a reader sees in the channel. */
  readonly opener: string;
  /** The task the agent picks up inside it. */
  readonly prompt: string;
}

export interface ForkReport {
  readonly created: readonly SpawnedThread[];
  readonly failed: readonly { readonly opener: string; readonly reason: string }[];
}

/**
 * Parse `--threads` — a JSON array of `{opener, prompt}`.
 *
 * JSON rather than repeated flags because `--opener` and `--prompt` each
 * consume the rest of the line, so a repeated form cannot say where one thread
 * ends and the next begins.
 */
export const parseThreads = (
  raw: string | undefined
): Result.Result<readonly ForkThread[], Error> => {
  if (raw === undefined || raw.trim().length === 0) {
    return Result.fail(new Error("--threads is required"));
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (cause) {
    return Result.fail(
      new Error(`--threads must be valid JSON: ${String(cause)}`)
    );
  }
  if (!Array.isArray(decoded) || decoded.length === 0) {
    return Result.fail(
      new Error("--threads must be a non-empty JSON array of {opener, prompt}")
    );
  }
  if (decoded.length > MAX_FORK) {
    return Result.fail(
      new Error(
        `--threads asks for ${decoded.length} threads; the limit is ${MAX_FORK}`
      )
    );
  }
  const threads: ForkThread[] = [];
  for (const [index, entry] of decoded.entries()) {
    const row = entry as { opener?: unknown; prompt?: unknown };
    if (typeof row.opener !== "string" || row.opener.trim().length === 0) {
      return Result.fail(new Error(`thread ${index + 1} has no opener`));
    }
    if (typeof row.prompt !== "string" || row.prompt.trim().length === 0) {
      return Result.fail(new Error(`thread ${index + 1} has no prompt`));
    }
    threads.push({
      opener: row.opener,
      prompt: row.prompt,
    });
  }
  return Result.succeed(threads);
};

/**
 * Open every thread, and report what happened to each.
 *
 * One failure does not stop the rest: the user asked for several threads, and
 * the useful answer is "these two opened, this one did not" rather than
 * abandoning the run halfway with nothing said about either.
 */
export const runFork = async (opts: {
  readonly channel: string;
  readonly depth: number;
  readonly env: Record<string, string | undefined>;
  readonly fetchImpl?: FetchLike | undefined;
  readonly postMessageImpl?: typeof postMessage | undefined;
  readonly threads: readonly ForkThread[];
  readonly updateMessageImpl?: typeof updateMessage | undefined;
}): Promise<ForkReport> => {
  const created: SpawnedThread[] = [];
  const failed: { opener: string; reason: string }[] = [];

  for (const thread of opts.threads) {
    // eslint-disable-next-line no-await-in-loop -- sequential on purpose; see the header
    const result = await runNew({
      channel: opts.channel,
      depth: opts.depth,
      env: opts.env,
      fetchImpl: opts.fetchImpl,
      opener: thread.opener,
      postMessageImpl: opts.postMessageImpl,
      prompt: thread.prompt,
      updateMessageImpl: opts.updateMessageImpl,
    });
    if (Result.isFailure(result)) {
      failed.push({
        opener: thread.opener,
        reason: result.failure.message,
      });
    } else {
      created.push(result.success);
    }
  }

  return {
    created,
    failed,
  };
};
