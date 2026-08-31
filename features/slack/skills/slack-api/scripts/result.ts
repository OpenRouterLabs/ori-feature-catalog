import { Data, Effect, Result } from "effect";

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

export const tryCatch = <T>(fn: () => T): Result.Result<T, ThrownError> =>
  Result.try({
    try: fn,
    catch: toThrownError,
  });

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

export const unreadable = (): undefined => undefined;

export const isString = (val: unknown): val is string =>
  typeof val === "string";

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
