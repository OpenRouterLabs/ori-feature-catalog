import { describe, expect, it as bunIt, test } from "bun:test";

import { Cause, Effect, Exit } from "effect";

const run = <A, E>(self: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(
    Effect.exit(self).pipe(
      Effect.flatMap((exit) => {
        if (Exit.isFailure(exit)) {
          for (const error of Cause.prettyErrors(exit.cause)) {
            Effect.runSync(Effect.logError(error));
          }
        }
        return exit;
      })
    )
  );

const testEffect = Object.assign(
  function effect(
    name: string,
    self: () => Effect.Effect<unknown, unknown>,
    timeout?: number
  ) {
    bunIt(name, () => run(self()), timeout);
  },
  {
    skip: (name: string) => bunIt.skip(name, () => {}),
    each:
      <T>(cases: readonly T[]) =>
      (
        name: string,
        self: (item: T) => Effect.Effect<unknown, unknown>,
        timeout?: number
      ) => {
        for (const [index, item] of cases.entries()) {
          const label =
            typeof item === "object" && item !== null && "name" in item
              ? String((item as { readonly name: unknown }).name)
              : `case ${index}`;
          bunIt(`${name} — ${label}`, () => run(self(item)), timeout);
        }
      },
  }
);

export const it = Object.assign(bunIt, {
  effect: testEffect,
  live: testEffect,
});
export { describe, expect, test };
