/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */

import { Effect, Result } from "effect";

import type { ThreadRef } from "../../thread/thread.ts";
import type { Addressed } from "./loopback-route.ts";

import { parseDispatchBody } from "./dispatch.ts";
import { loopbackRoute, refuse } from "./loopback-route.ts";

const HTTP_SERVICE_UNAVAILABLE = 503;

interface DispatchRequest extends Addressed {
  readonly depth: number | undefined;
  readonly message: string;
  readonly userId: string | undefined;
}

const parse = (raw: unknown): Result.Result<DispatchRequest, string> => {
  const parsed = parseDispatchBody(raw);
  return parsed.ok
    ? Result.succeed({
        channel: parsed.request.channel,
        depth: parsed.request.depth,
        message: parsed.request.message,
        team: undefined,
        threadTs: parsed.request.threadTs,
        userId: parsed.request.userId,
      })
    : Result.fail(parsed.error);
};

export const makeDispatchRoute = (deps: {
  readonly isStopping: () => boolean;
  readonly runTurnSafely: (turn: {
    readonly ref: ThreadRef;
    readonly spawnDepth?: number | undefined;
    readonly text: string;
    readonly userId: string;
  }) => void;
  readonly workspaceTeamId: string;
}): ((request: Request) => Promise<Response>) =>
  loopbackRoute<DispatchRequest, Record<string, never>>({
    capKiB: 128,
    handle: ({ ref, request }) => {
      if (deps.isStopping()) {
        return Effect.succeed(refuse(HTTP_SERVICE_UNAVAILABLE, "shutting down"));
      }

      deps.runTurnSafely({
        ref,
        spawnDepth: request.depth,
        text: request.message,
        userId: request.userId ?? "",
      });

      return Effect.succeed(Result.succeed({}));
    },
    parse,
    workspaceTeamId: deps.workspaceTeamId,
  });
