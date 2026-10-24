import { describe, expect, test } from "bun:test";
// The alert paths inside `schedule.ts`'s `matchEffect` branches must SWALLOW a
// failing `postAlert` after logging it. Pre-fix the typed `AlertPostError`
// escaped `matchEffect` and rejected the whole `run` handler — the schedule
// fire then recorded status "error" with the SLACK failure instead of the
// GitHub failure it exists to surface, and (because a `run` handler is
// replay-can-duplicate-work) no retry ever fired. The alert only ever landed
// while Slack was healthy — precisely when the page is not needed.
//
// The schedule module itself is NOT imported (`ori` is a gitignored local SDK
// on a fresh checkout); this suite pins the source contract the same way
// schedule-repo-resolver.test.ts does, and executes the exact Effect wiring
// with fakes to prove a swallowed alert failure completes the fire.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Data, Effect, Exit } from "effect";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "schedule.ts"),
  "utf-8"
);

/** The schedule's own tagged error, mirrored for the behavioral test. */
class AlertPostError extends Data.TaggedError("AlertPostError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error
      ? this.cause.message
      : String(this.cause);
  }
}

describe("gh-auth-health alert failure handling", () => {
  test("the schedule swallows the postAlert failure after logging it", () => {
    // Source contract: every `catch: (cause) => new AlertPostError({ cause })`
    // is followed by an `Effect.catch` that logs and completes — the typed
    // failure never escapes the onFailure branch.
    const postSites = source.matchAll(
      /catch: \(cause\) => new AlertPostError\(\{ cause \}\)/gu
    );
    const swallowed =
      /Effect\.catch\(\(error\) =>/gu;
    const postCount = [...postSites].length;
    expect(postCount).toBe(2);
    const swallowCount = [...source.matchAll(swallowed)].length;
    expect(swallowCount).toBe(postCount);
  });

  test("behavioral: a failing postAlert inside the onFailure branch completes the fire", async () => {
    // The exact wiring the schedule uses, with a postAlert that rejects.
    const calls: string[] = [];
    const logged: string[] = [];
    const postAlert = (): Promise<void> => {
      calls.push("attempted");
      return Promise.reject(new Error("channel_not_found"));
    };
    const healthFailed = Effect.fail<{ detail: string }>({
      detail: "GitHub installations list failed: HTTP 401",
    });
    const run = Effect.gen(function* () {
      yield* healthFailed.pipe(
        Effect.matchEffect({
          onSuccess: () => Effect.sync(() => {}),
          onFailure: (failure) =>
            Effect.gen(function* () {
              yield* Effect.logWarning(formatHealthErrorLog(failure));
              yield* Effect.tryPromise({
                try: () => postAlert(),
                catch: (cause) => new AlertPostError({ cause }),
              }).pipe(
                Effect.catch((error) =>
                  Effect.sync(() => {
                    logged.push(
                      `gh-auth-health: could not post the Slack alert (${error.message})`
                    );
                  })
                )
              );
            }),
        })
      );
    });
    const exit = await Effect.runPromiseExit(run);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(calls).toEqual(["attempted"]);
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain("could not post the Slack alert");
  });

  test("behavioral: a successful postAlert still posts exactly once", async () => {
    const calls: string[] = [];
    const postAlert = (): Promise<void> => {
      calls.push("attempted");
      return Promise.resolve();
    };
    const healthFailed = Effect.fail<{ detail: string }>({
      detail: "GitHub installations list failed: HTTP 401",
    });
    const run = Effect.gen(function* () {
      yield* healthFailed.pipe(
        Effect.matchEffect({
          onSuccess: () => Effect.sync(() => {}),
          onFailure: (failure) =>
            Effect.gen(function* () {
              yield* Effect.tryPromise({
                try: () => postAlert(),
                catch: (cause) => new AlertPostError({ cause }),
              }).pipe(
                Effect.catch(() => Effect.sync(() => {}))
              );
            }),
        })
      );
    });
    const exit = await Effect.runPromiseExit(run);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(calls).toEqual(["attempted"]);
  });
});

const formatHealthErrorLog = (failure: { detail: string }): string =>
  `gh-auth-health: FAILED for owner/repo — ${failure.detail}`;
