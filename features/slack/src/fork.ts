/**
 * fork.ts — running something and forgetting it, without losing the failure.
 *
 * `void somePromise()` turns a DEFECT into an unhandled rejection at the
 * process level, which in Bun can take the daemon down and at best vanishes.
 * Forking keeps it inside the Effect runtime, where it is logged and the
 * surface carries on.
 */

import type { Context } from "effect";

import { Effect } from "effect";

import type { SlackServices } from "./layers.ts";

export const forkWith =
  (context: Context.Context<SlackServices>) =>
  (effect: Effect.Effect<void, never, SlackServices>): void => {
    Effect.runFork(
      effect.pipe(
        Effect.provide(context),
        Effect.catchDefect((defect: unknown) =>
          Effect.logError("[slack] a surface event failed", defect)
        )
      )
    );
  };
