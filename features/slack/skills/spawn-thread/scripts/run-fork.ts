import { Result } from "effect";

import type { FetchLike } from "./spawn-thread.ts";
import type { postMessage } from "./post-message.ts";
import type { SpawnedThread } from "./run-new.ts";
import type { updateMessage } from "./update-message.ts";

import { runNew } from "./run-new.ts";

export const MAX_FORK = 5;

export interface ForkThread {
  readonly opener: string;
  readonly prompt: string;
}

export interface ForkReport {
  readonly created: readonly SpawnedThread[];
  readonly failed: readonly { readonly opener: string; readonly reason: string }[];
}

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
