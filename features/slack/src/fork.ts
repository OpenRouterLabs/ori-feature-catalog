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
        ),
        Effect.withSpan("Slack.runtime.fork")
      )
    );
  };
