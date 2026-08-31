/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */

import { Effect, Result, Schema } from "effect";

import type { ThreadRef } from "../../thread/thread.ts";
import type { CarryResult } from "../carry.ts";
import type { Addressed } from "./loopback-route.ts";

import { CarryOutcome } from "../carry.ts";
import { loopbackRoute, refuse } from "./loopback-route.ts";

const HTTP_CONFLICT = 409;
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_UNPROCESSABLE = 422;

interface CarryRequest extends Addressed {
  readonly toThreadTs: string;
}

const CarryBodySchema = Schema.Struct({
  channel: Schema.String,
  thread_ts: Schema.String,
  to_thread_ts: Schema.String,
});

const decodeBody = Schema.decodeUnknownResult(CarryBodySchema);

const blank = (value: string): boolean => value.trim().length === 0;

const parse = (raw: unknown): Result.Result<CarryRequest, string> =>
  Result.match(decodeBody(raw), {
    onFailure: (): Result.Result<CarryRequest, string> =>
      Result.fail("expected { channel, thread_ts, to_thread_ts }"),
    onSuccess: (decoded): Result.Result<CarryRequest, string> => {
      if (blank(decoded.channel)) {
        return Result.fail("channel must not be empty");
      }
      if (blank(decoded.thread_ts)) {
        return Result.fail("thread_ts (the thread being carried) must not be empty");
      }
      if (blank(decoded.to_thread_ts)) {
        return Result.fail("to_thread_ts (the destination thread) must not be empty");
      }
      if (decoded.thread_ts === decoded.to_thread_ts) {
        return Result.fail("a thread cannot be carried onto itself");
      }
      return Result.succeed({
        channel: decoded.channel,
        team: undefined,
        threadTs: decoded.thread_ts,
        toThreadTs: decoded.to_thread_ts,
      });
    },
  });

export const makeCarryRoute = (deps: {
  readonly carry: (input: {
    readonly from: ThreadRef;
    readonly to: ThreadRef;
  }) => Promise<CarryResult>;
  readonly isBusy: (ref: ThreadRef) => boolean;
  readonly isStopping: () => boolean;
  readonly workspaceTeamId: string;
}): ((request: Request) => Promise<Response>) =>
  loopbackRoute<CarryRequest, { readonly sessionId: string }>({
    capKiB: 16,
    handle: Effect.fn("Slack.carry.handle")(function* ({ ref, request }) {
      if (deps.isStopping()) {
        return refuse(HTTP_SERVICE_UNAVAILABLE, "shutting down");
      }

      if (deps.isBusy(ref)) {
        return refuse(
          HTTP_CONFLICT,
          "that thread is mid-turn; carry it once the run finishes"
        );
      }

      const result = yield* Effect.promise(() =>
        deps.carry({
          from: ref,
          to: {
            ...ref,
            threadTs: request.toThreadTs,
          },
        })
      );

      return result.kind === CarryOutcome.NothingToCarry
        ? refuse(
            HTTP_UNPROCESSABLE,
            "that thread has no session to carry — nothing has run in it yet"
          )
        : Result.succeed({ sessionId: result.sessionId });
    }),
    parse,
    workspaceTeamId: deps.workspaceTeamId,
  });
