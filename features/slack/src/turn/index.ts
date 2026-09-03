import { Cause, Context, Effect } from "effect";

import type { RawSlackMessage } from "#src/surface/listeners.ts";
import type { TurnRouteDeps, TurnRoutes } from "./turn-routes.ts";

import { StateStore } from "#src/state/store.ts";
import { claimStart } from "./listening/starts.ts";
import { makeTurnRouteHandlers } from "./routes/index.ts";
import { makeRunTurn, makeStartTurn } from "./turn-routes.ts";

export const makeTurnRoutes = (deps: TurnRouteDeps): TurnRoutes => {
  const runTurn = makeRunTurn({
    bridge: deps.bridge,
    interruptMode: () => Context.get(deps.context, StateStore).getInterruptMode(),
    logger: deps.logger,
    onItAfterMs: deps.config.onItAfterMs,
    postQueuedNotice: deps.postQueuedNotice,
    runWith: deps.runWith,
  });

  const runTurnSafely = (turn: Parameters<typeof runTurn>[0]): void => {
    void Effect.runPromise(
      runTurn(turn).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            deps.logger.error(
              "[slack] dispatched turn failed",
              Cause.squash(cause)
            );
          })
        )
      )
    );
  };

  const startTurn = makeStartTurn({
    engagement: deps.engagement,
    sayFailed: deps.sayFailed,
    startStatus: deps.startStatus,
    messageOf: deps.messageOf,
    runTurn,
    started: claimStart(),
    token: deps.token,
    workspaceTeamId: deps.workspaceTeamId,
  });

  const startTurnSafely = (
    event: RawSlackMessage,
    addressed: boolean
  ): void => {
    void Effect.runPromise(
      startTurn(event, addressed).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            deps.logger.error("[slack] turn failed", Cause.squash(cause));
          })
        )
      )
    );
  };

  return {
    ...makeTurnRouteHandlers({ deps, runTurnSafely }),
    runTurnSafely,
    startTurnSafely,
  };
};
