import { describe, expect, test } from "bun:test";
// The App-mode health check mints, then verifies the token reaches the repo
// with `GET /repos/{repo}`. Pre-fix that fetch had NO deadline while the
// ambient probe (the same schedule's other half) had one: a hung connection
// — a dropped route, a wedged egress proxy after the mint — left the check
// pending forever, the fire never completed, and the runtime skipped every
// later fire. The schedule whose whole job is to ALERT on broken GitHub
// access stayed silent in exactly the state it exists to catch, in the mode
// (App) it was originally built for.
//
// The round-trip now bounds the wait and fails a `round-trip`
// HealthCheckError naming the deadline, the same channel a 5xx uses. The
// deadline test waits out a real 15s timeout against a fetch that never
// settles (the honest wedge shape), so it carries a 25s per-test timeout —
// the same shape as ambient-timeout.test.ts.
import { Effect } from "effect";

import { ghAuthHealthCheck } from "./gh-auth-health.ts";

const neverFetch = (): Promise<Response> => new Promise<Response>(() => {});

const minted = Effect.succeed({
  expiresAt: "2026-01-01T00:00:00Z",
  token: "not-a-real-token",
});

describe("an App-mode round-trip that never settles fails, never wedges the fire", () => {
  test(
    "the round-trip's deadline fires instead of hanging",
    async () => {
      const outcome = await Effect.runPromise(
        ghAuthHealthCheck({
          fetchImpl: neverFetch,
          mint: minted,
          repo: "acme/widgets",
        }).pipe(
          Effect.match({
            onFailure: (error) => ({
              detail: error.detail,
              ok: false as const,
              stage: error.stage,
            }),
            onSuccess: () => ({ ok: true as const }),
          })
        )
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.stage).toBe("round-trip");
        expect(outcome.detail).toContain("did not answer within");
        expect(outcome.detail).toContain("acme/widgets");
      }
    },
    25_000
  );

  test("a 401 keeps failing through the same round-trip channel as before", async () => {
    const outcome = await Effect.runPromise(
      ghAuthHealthCheck({
        fetchImpl: () =>
          Promise.resolve(
            Response.json(
              { message: "Bad credentials" },
              { status: 401 }
            )
          ) as Promise<Response>,
        mint: minted,
        repo: "acme/widgets",
      }).pipe(
        Effect.match({
          onFailure: (error) => ({
            detail: error.detail,
            ok: false as const,
            stage: error.stage,
          }),
          onSuccess: () => ({ ok: true as const }),
        })
      )
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.stage).toBe("round-trip");
      expect(outcome.detail).toContain("Bad credentials");
    }
  });
});
