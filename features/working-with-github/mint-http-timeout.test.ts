import { describe, expect, test } from "bun:test";
// mint-http-timeout.test.ts — both mint-path fetches (the `GET
// /app/installations` page walk and the `POST …/access_tokens` call) must
// carry a request deadline. Pre-fix neither had one, so a hung connection to
// api.github.com (a dropped route, a wedged proxy) left
// `GH_TOKEN=$(bun mint-token.ts)` pending FOREVER — the command substitution
// blocks the caller's whole shell, `commit-via-api.ts` (which mints
// internally) never returns, and the `gh-auth-health` fire whose job is to
// alert on exactly this state is itself wedged behind the same unbounded
// mint. Every sibling network path in this feature already bounds its wait
// (`PR_LOOKUP_TIMEOUT_MS` in the sweep, `AMBIENT_PROBE_TIMEOUT_MS` /
// `ROUND_TRIP_TIMEOUT_MS` in the health check, `POST_ALERT_TIMEOUT_MS` on the
// Slack post) — the mint is the one network path they all DEPEND on, and the
// only one still unbounded.
//
// The suite pins both halves with the honest wedge shape (a fetch that never
// settles) against a REAL clock: the effect must FAIL within the deadline,
// not merely be cancellable. The per-test timeouts leave margin for CI jitter.
import { Effect } from "effect";

import { discoverInstallationId } from "./gh-app-github-api.ts";
import { requestInstallationToken } from "./gh-app-github-api.ts";

/** A fetch seam whose promise NEVER settles — the hung-connection shape. */
const neverFetch = (): Promise<Response> => new Promise<Response>(() => {});

/** Wall-clock ms the effect took to settle, plus its outcome label. */
const timed = async <A, E>(
  effect: Effect.Effect<A, E>
): Promise<{ label: string; ms: number }> => {
  const startedAt = Date.now();
  const outcome = await Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (error) =>
          `failed: ${error instanceof Error ? error.message : String(error)}`,
        onSuccess: () => "succeeded",
      })
    )
  );
  return { label: outcome, ms: Date.now() - startedAt };
};

// The deadline the fix introduces; long enough that a real page fetch
// (one HTTPS round-trip) always answers inside it, short enough that a
// wedged mint fails a human-visible amount of time.
const DEADLINE_MS = 15_000;
const WEDGE_MARGIN_MS = 5_000;

describe("the mint path bounds every HTTP wait", () => {
  test(
    "a wedged installations page walk fails within the deadline, never hangs",
    async () => {
      const outcome = await timed(
        discoverInstallationId(neverFetch, "jwt", "acme", new Set(["acme"]))
      );
      expect(outcome.label).toContain("did not answer within");
      expect(outcome.ms).toBeLessThan(DEADLINE_MS + WEDGE_MARGIN_MS);
    },
    (DEADLINE_MS + WEDGE_MARGIN_MS + 5_000) as never
  );

  test(
    "a wedged access-token POST fails within the deadline, never hangs",
    async () => {
      const outcome = await timed(
        requestInstallationToken(neverFetch, "jwt", "42")
      );
      expect(outcome.label).toContain("did not answer within");
      expect(outcome.ms).toBeLessThan(DEADLINE_MS + WEDGE_MARGIN_MS);
    },
    (DEADLINE_MS + WEDGE_MARGIN_MS + 5_000) as never
  );

  test("the deadline preserves the honest failure channels", async () => {
    // A settled non-2xx still reports its own status — the stale-installation
    // retry in gh-app-token.ts matches `op:"http"` + status 401/404, and the
    // deadline must never replace that shape.
    const label = await Effect.runPromise(
      requestInstallationToken(
        () =>
          Promise.resolve(
            new Response(JSON.stringify({ message: "Not Found" }), {
              status: 404,
            })
          ) as Promise<Response>,
        "jwt",
        "42"
      ).pipe(
        Effect.match({
          onFailure: (error) => `op=${error.op} status=${error.status}`,
          onSuccess: () => "succeeded",
        })
      )
    );
    expect(label).toBe("op=http status=404");
  });
});
