/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * dispatch-route.ts — the HTTP half of the loopback dispatch route.
 *
 * Skips the gates deliberately: the caller is the agent itself over loopback,
 * not a Slack user, so allowlists, mention rules and the listen heuristic do
 * not apply. The loopback check in `feature.ts` is what makes that safe.
 */

import { Result } from "effect";

import type { ThreadRef } from "../../thread/index.ts";
import type { Addressed } from "./loopback-route.ts";

import { parseDispatchBody } from "./dispatch.ts";
import { loopbackRoute, refuse } from "./loopback-route.ts";

const HTTP_SERVICE_UNAVAILABLE = 503;

/**
 * A dispatch body carries no `team`: `spawn-thread` never sends one, and it
 * should not be able to. Adding the field to make the shape uniform would let
 * a caller point a spawned turn at another workspace.
 */
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
    // A dispatch body is a few fields of JSON; anything larger is not one.
    capKiB: 128,
    handle: ({ ref, request }) => {
      if (deps.isStopping()) {
        // The caller is a skill that can report this, unlike a Slack event.
        return Promise.resolve(
          refuse(HTTP_SERVICE_UNAVAILABLE, "shutting down")
        );
      }

      // Do not await the turn: the skill's HTTP call must return promptly, and
      // the run continues on its own.
      deps.runTurnSafely({
        ref,
        // Carried into the spawned agent's env so its own spawn-thread guard
        // counts from here rather than from zero.
        spawnDepth: request.depth,
        text: request.message,
        userId: request.userId ?? "",
      });

      return Promise.resolve(Result.succeed({}));
    },
    parse,
    workspaceTeamId: deps.workspaceTeamId,
  });
