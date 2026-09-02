import { Effect, Result, Schema } from "effect";

import type { ThreadRef } from "#src/thread/thread.ts";

import { parseDispatchBody } from "./dispatch.ts";
import { AddressedSchema, loopbackRoute, refuse } from "./loopback-route.ts";

const HTTP_SERVICE_UNAVAILABLE = 503;

const DispatchRequestSchema = Schema.Struct({
  ...AddressedSchema.fields,
  depth: Schema.UndefinedOr(Schema.Number),
  message: Schema.String,
  userId: Schema.UndefinedOr(Schema.String),
});

type DispatchRequest = typeof DispatchRequestSchema.Type;

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
