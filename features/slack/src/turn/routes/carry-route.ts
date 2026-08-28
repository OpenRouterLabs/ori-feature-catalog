/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * carry-route.ts — the HTTP half of the carry route.
 *
 * The skill posts the destination thread (it already knows how, from the
 * `new` workflow) and then calls this to move the session onto it. The
 * rebinding has to happen in the daemon: the store and the turn registry both
 * live here, and a skill cannot see either.
 *
 * Like dispatch, this skips the gates — the caller is the agent over loopback,
 * not a Slack user — and the loopback check in `feature.ts` is what makes that
 * safe.
 */

import { Result } from "effect";

import type { ThreadRef } from "../../thread/index.ts";
import type { CarryResult } from "../carry.ts";
import type { Addressed } from "./loopback-route.ts";

import { CarryOutcome } from "../carry.ts";
import { loopbackRoute, refuse } from "./loopback-route.ts";

const HTTP_CONFLICT = 409;
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_UNPROCESSABLE = 422;

/**
 * Origin thread in the `Addressed` fields, destination alongside.
 *
 * Same channel by construction: the destination is a top-level message the
 * caller has just posted, and carrying across channels would let a thread
 * move somewhere its participants cannot see.
 */
interface CarryRequest extends Addressed {
  readonly toThreadTs: string;
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const parse = (raw: unknown): Result.Result<CarryRequest, string> => {
  if (typeof raw !== "object" || raw === null) {
    return Result.fail("body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;
  if (!nonEmpty(body.channel)) {
    return Result.fail("channel is required");
  }
  if (!nonEmpty(body.thread_ts)) {
    return Result.fail("thread_ts (the thread being carried) is required");
  }
  if (!nonEmpty(body.to_thread_ts)) {
    return Result.fail("to_thread_ts (the destination thread) is required");
  }
  if (body.thread_ts === body.to_thread_ts) {
    return Result.fail("a thread cannot be carried onto itself");
  }
  return Result.succeed({
    channel: body.channel,
    team: undefined,
    threadTs: body.thread_ts,
    toThreadTs: body.to_thread_ts,
  });
};

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
    // Three ids of JSON; anything larger is not a carry.
    capKiB: 16,
    handle: async ({ ref, request }) => {
      if (deps.isStopping()) {
        return refuse(HTTP_SERVICE_UNAVAILABLE, "shutting down");
      }

      // Rebinding underneath a running turn would hand the destination a
      // session the origin's turn is still writing to. Refusing is the honest
      // answer: the caller is a skill that can say so and try again.
      if (deps.isBusy(ref)) {
        return refuse(
          HTTP_CONFLICT,
          "that thread is mid-turn; carry it once the run finishes"
        );
      }

      const result = await deps.carry({
        from: ref,
        to: {
          ...ref,
          threadTs: request.toThreadTs,
        },
      });

      return result.kind === CarryOutcome.NothingToCarry
        ? refuse(
            HTTP_UNPROCESSABLE,
            "that thread has no session to carry — nothing has run in it yet"
          )
        : Result.succeed({ sessionId: result.sessionId });
    },
    parse,
    workspaceTeamId: deps.workspaceTeamId,
  });
