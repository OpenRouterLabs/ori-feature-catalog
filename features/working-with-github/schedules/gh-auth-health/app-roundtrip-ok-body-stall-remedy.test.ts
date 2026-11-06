import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { ghAuthHealthCheck, renderHealthAlert } from "./gh-auth-health.ts";

/**
 * Regression: a round-trip that answered 2xx and then stalled its body past
 * the deadline failed with no `kind`, so the App-mode alert paged "GitHub auth
 * is not working … check that the host is injecting and rotating GH_TOKEN".
 * A 2xx is GitHub ACCEPTING the token; the stall means the answer never
 * finished arriving, the same unreachable class the non-2xx body stall, the
 * fetch deadline and a 5xx already page as "the token was never tested".
 */

const AUTH_REMEDY = "Check that the host is injecting and rotating `GH_TOKEN`";

const stalledOk = (): Promise<Response> =>
  Promise.resolve(
    new Response(new ReadableStream({ start() {} }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    })
  );

describe("a 2xx round-trip whose body stalls pages an outage, not broken auth", () => {
  test(
    "the failure is unreachable and the alert drops the token-rotation remedy",
    async () => {
      const failure = await Effect.runPromise(
        Effect.flip(
          ghAuthHealthCheck({
            fetchImpl: stalledOk,
            mint: Effect.succeed({ token: "t" }),
            repo: "acme/widgets",
          })
        )
      );
      expect(failure.stage).toBe("round-trip");
      expect(failure.detail).toContain("did not arrive within");
      expect(failure.kind).toBe("unreachable");
      const alert = renderHealthAlert("acme/widgets", failure);
      expect(alert).toContain("never tested");
      expect(alert).not.toContain(AUTH_REMEDY);
    },
    25_000
  );
});
