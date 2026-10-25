import { describe, expect, test } from "bun:test";
// The App-mode round-trip bounds its FETCH with `ROUND_TRIP_TIMEOUT_MS`, but
// pre-fix BOTH of its body reads — the non-2xx envelope read and the 2xx
// payload read — ran `response.json()` with NO bound of their own. A server
// that answers the headers (200, or a 401) and then stalls the body is the
// same wedge the fetch deadline exists to close, reopened through the body
// read: the read stays pending forever, the fire never completes, the runtime
// skips every later fire, and the schedule whose whole job is to ALERT on
// broken GitHub access stays silent in exactly the state it exists to catch.
// Every sibling body read in this feature (`readBodyJson` in
// `gh-app-github-api.ts`, `ghJson` in `commit-api-core.ts`) is bounded by the
// same deadline as its fetch; this closes the one path that was not.
//
// The tests wait out a real 15s body-read deadline against a stream that
// never enqueues (the honest wedge shape), so they carry a 25s per-test
// timeout — the same shape as app-roundtrip-timeout.test.ts.
import { Effect } from "effect";

import { ghAuthHealthCheck } from "./gh-auth-health.ts";

/** A Response whose headers answer but whose body never arrives. */
const stallBodyResponse = (): Response =>
  new Response(
    new ReadableStream({
      start() {
        // Never enqueue, never close: `response.json()` stays pending forever.
      },
    }),
    {
      headers: { "Content-Type": "application/json" },
      status: 200,
    }
  );

const stallBodyFetch = (): Promise<Response> =>
  Promise.resolve(stallBodyResponse());

const minted = Effect.succeed({
  expiresAt: "2026-01-01T00:00:00Z",
  token: "not-a-real-token",
});

describe("an App-mode round-trip whose body never arrives fails, never wedges the fire", () => {
  test(
    "a 200 whose body stalls fails the check at the deadline, not forever",
    async () => {
      const outcome = await Effect.runPromise(
        ghAuthHealthCheck({
          fetchImpl: stallBodyFetch,
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
        expect(outcome.detail).toContain("did not arrive within");
        expect(outcome.detail).toContain("acme/widgets");
      }
    },
    25_000
  );

  test(
    "a non-2xx whose body stalls still explains itself at the deadline",
    async () => {
      const stallErrorBodyFetch = (): Promise<Response> =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start() {
                // stall
              },
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 401,
            }
          )
        );
      const outcome = await Effect.runPromise(
        ghAuthHealthCheck({
          fetchImpl: stallErrorBodyFetch,
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
        // The deadline fires before the envelope read can hang: the 401 is
        // reported (never wedged), through the same round-trip channel.
        expect(outcome.stage).toBe("round-trip");
        expect(outcome.detail).toContain("did not arrive within");
      }
    },
    25_000
  );

  test("a prompt 200 body still reads as health", async () => {
    const outcome = await Effect.runPromise(
      ghAuthHealthCheck({
        fetchImpl: () =>
          Promise.resolve(
            Response.json(
              { full_name: "acme/widgets" },
              { status: 200 }
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
          onSuccess: (ok) => ({
            full_name: ok.repoFullName,
            ok: true as const,
          }),
        })
      )
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.full_name).toBe("acme/widgets");
    }
  });
});