/**
 * best-effort.ts — recovering what may fail without hiding what cannot.
 *
 * `Effect.ignore` discards a failure AND a defect, and those are different
 * things. A Slack refusal on a cosmetic edit is an expected failure: the
 * buttons are already answered, the rewrite was tidiness. A throw out of our
 * own block builder is a defect — a bug — and dropping it silently is how one
 * survives a release.
 *
 * So this recovers the failure and leaves the defect audible. Nothing that
 * used `Effect.ignore` wanted a bug hidden; that was a side effect of the
 * combinator being the shortest thing to reach for.
 */

import { Effect } from "effect";

/**
 * Recover any failure, log any defect. Pipeable:
 * `yield* thing().pipe(bestEffort)`.
 */
export const bestEffort = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.tapDefect((defect) =>
      Effect.logError("[slack] defect in best-effort work", defect)
    ),
    Effect.ignore
  );
