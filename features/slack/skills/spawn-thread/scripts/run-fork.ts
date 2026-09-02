import { Result, Schema } from "effect";

import type { FetchLike } from "./spawn-thread.ts";
import type { postMessage } from "./post-message.ts";
import { type SpawnedThread, SpawnedThreadSchema, runNew } from "./run-new.ts";
import type { updateMessage } from "./update-message.ts";


export const MAX_FORK = 5;

const ForkThreadSchema = Schema.Struct({
  opener: Schema.String,
  prompt: Schema.String,
});

export type ForkThread = typeof ForkThreadSchema.Type;

const ForkReportSchema = Schema.Struct({
  created: Schema.Array(SpawnedThreadSchema),
  failed: Schema.Array(
    Schema.Struct({
      opener: Schema.String,
      reason: Schema.String,
    })
  ),
});

export type ForkReport = typeof ForkReportSchema.Type;

const NonBlankString = Schema.String.check(
  Schema.makeFilter((value) =>
    value.trim().length === 0 ? "must not be blank" : undefined
  )
);

const ForkThreadsFromJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({ opener: NonBlankString, prompt: NonBlankString })
  )
);

const decodeThreads = Schema.decodeUnknownResult(ForkThreadsFromJson);

export const parseThreads = (
  raw: string | undefined
): Result.Result<readonly ForkThread[], Error> => {
  if (raw === undefined || raw.trim().length === 0) {
    return Result.fail(new Error("--threads is required"));
  }
  const decoded = decodeThreads(raw);
  if (Result.isFailure(decoded)) {
    return Result.fail(
      new Error(
        "--threads must be a JSON array of { opener, prompt }, both non-empty"
      )
    );
  }
  if (decoded.success.length === 0) {
    return Result.fail(
      new Error("--threads must be a non-empty JSON array of {opener, prompt}")
    );
  }
  if (decoded.success.length > MAX_FORK) {
    return Result.fail(
      new Error(
        `--threads asks for ${decoded.success.length} threads; the limit is ${MAX_FORK}`
      )
    );
  }
  return Result.succeed(decoded.success);
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
