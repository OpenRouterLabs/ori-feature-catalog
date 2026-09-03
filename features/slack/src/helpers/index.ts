import { Effect } from "effect";

export const bestEffort = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.tapDefect((defect) =>
      Effect.logError("[slack] defect in best-effort work", defect)
    ),
    Effect.ignore
  );
