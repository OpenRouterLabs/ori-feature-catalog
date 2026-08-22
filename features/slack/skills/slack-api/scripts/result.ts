import { Data, Effect, Result } from "effect";

/**
 * Tagged error the `tryCatch*` wrappers put in the `Result` failure channel, so
 * it stays typed (`ThrownError`) instead of the opaque global `Error` the
 * language-service flags. It still `extends Error` (via `Data.TaggedError`), and
 * its `message`/`name` getters delegate to the original `cause` — preserving the
 * old "the failure channel is the thrown Error" contract that callers rely on
 * (e.g. `result.failure.name === "AbortError"`, `result.failure.message`).
 */
class ThrownError extends Data.TaggedError("ThrownError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error
      ? this.cause.message
      : String(this.cause);
  }
  override get name(): string {
    return this.cause instanceof Error ? this.cause.name : "ThrownError";
  }
}
const toThrownError = (cause: unknown): ThrownError =>
  new ThrownError({
    cause,
  });

/**
 * Wrap a potentially-throwing synchronous call in a `Result`. Thin wrapper over
 * `Result.try` that wraps the thrown value in a tagged `ThrownError` (matching
 * the old `tryCatch` contract: the failure channel is always the thrown error).
 */
export const tryCatch = <T>(fn: () => T): Result.Result<T, ThrownError> =>
  Result.try({
    try: fn,
    catch: toThrownError,
  });

/**
 * Async counterpart of {@link tryCatch}. Effect has no one-line async `Result`
 * constructor, so this folds an `Effect.tryPromise` into a `Result` via
 * `Effect.match`. The folded Effect never fails, so `runPromise` never rejects —
 * preserving the "tryCatchAsync never rejects" contract.
 */
export const tryCatchAsync = <T>(
  fn: () => Promise<T>
): Promise<Result.Result<T, ThrownError>> =>
  Effect.runPromise(
    Effect.tryPromise({
      try: fn,
      catch: toThrownError,
    }).pipe(
      Effect.match({
        onSuccess: (data): Result.Result<T, ThrownError> =>
          Result.succeed(data),
        onFailure: (error): Result.Result<T, ThrownError> => Result.fail(error),
      })
    )
  );

export const isString = (val: unknown): val is string =>
  typeof val === "string";

/**
 * Parse `--flag value`, `--flag=value`, and bare boolean `--flag` into a flat
 * record of strings. A bare flag (no following value, or followed by another
 * `--flag`) becomes `"true"`. Mirrors the inline parser in
 * features/clickhouse/scripts/cli.ts so the skill stays dependency-free.
 */
export const parseFlags = (args: readonly string[]): Record<string, string> => {
  const flags: Record<string, string> = {};
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      i += 1;
      continue;
    }
    if (arg.includes("=")) {
      const eq = arg.indexOf("=");
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      i += 1;
      continue;
    }
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      flags[arg.slice(2)] = "true";
      i += 1;
    } else {
      flags[arg.slice(2)] = next;
      i += 2;
    }
  }
  return flags;
};
