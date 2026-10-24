import { describe, expect, test } from "bun:test";
// A health check that can wait forever can never alert. Pre-fix
// `ambientGitHubReachable` wrapped its fetch in `Effect.tryPromise` and
// nothing else: a hung connection — a dropped route, a wedged egress
// proxy — left the Effect pending forever, the fire never completed, the
// runtime skipped every later fire, and the schedule whose entire job is
// to ALERT on broken GitHub access stayed silent in exactly the state it
// exists to catch.
//
// The probe now bounds the wait and fails `AmbientProbeError` naming it.
// The deadline test waits out a real 15s timeout against a fetch that
// never settles (the honest wedge shape), so it carries a 25s per-test
// timeout.
import { Effect } from "effect";

import { ambientGitHubReachable } from "./gh-auth-health.ts";

const neverFetch = (): Promise<Response> => new Promise<Response>(() => {});

describe("an ambient probe that never settles fails, never wedges the fire", () => {
  test(
    "the probe's deadline fires instead of hanging",
    async () => {
      const outcome = await Effect.runPromise(
        ambientGitHubReachable({ fetchImpl: neverFetch }).pipe(
          Effect.match({
            onFailure: (error) => ({
              detail: error.detail,
              ok: false as const,
            }),
            onSuccess: () => ({ ok: true as const }),
          })
        )
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.detail).toContain("did not answer within");
      }
    },
    25_000
  );

  test("a 5xx is still the failure it always was", async () => {
    const outcome = await Effect.runPromise(
      ambientGitHubReachable({
        fetchImpl: () =>
          Promise.resolve(Response.json({}, { status: 503 })) as Promise<Response>,
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ detail: error.detail, ok: false as const }),
          onSuccess: () => ({ ok: true as const }),
        })
      )
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detail).toContain("503");
    }
  });
});
