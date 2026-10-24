import { describe, expect, test } from "bun:test";
// The ambient probe answers one question: can this workspace reach GitHub
// REST at all? A 401/403/404 without credentials is healthy-but-
// unauthenticated — the honest answer on a host whose proxy attaches
// nothing, and the schedule has nothing to alert about. But ONE 403 means
// the workspace cannot do any GitHub work: the rate limit is exhausted
// (`x-ratelimit-remaining: 0`). Pre-fix the probe reported HEALTHY in that
// state (reproduced live on a workspace whose anonymous core limit hit 0
// remaining — the log said "ok — GitHub API reachable" while every real
// REST call failed with 403), because the only failure branch keyed on
// `status >= 500`.
//
// The distinction is the header GitHub sends on every rate-limited response:
// `x-ratelimit-remaining: 0`. The scope-bearing 403 (a credential that lacks
// a scope) and the plain 401/404 stay healthy — those are auth answers, not
// "cannot work" ones.
import { Effect } from "effect";

import { ambientGitHubReachable } from "./gh-auth-health.ts";

const jsonResponse = (status: number, headers?: Record<string, string>) =>
  new Response(JSON.stringify({ message: "boom" }), {
    headers,
    status,
  });

const outcomeOf = () =>
  Effect.runPromise(
    ambientGitHubReachable({
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse(403, { "x-ratelimit-remaining": "0" })
        ) as Promise<Response>,
    }).pipe(
      Effect.match({
        onFailure: (error) => ({ detail: error.detail, ok: false as const }),
        onSuccess: (ok) => ({ ok: true as const, scopes: ok.scopes }),
      })
    )
  );

describe("the ambient probe distinguishes an exhausted rate limit from a healthy no-auth answer", () => {
  test("a 403 with x-ratelimit-remaining: 0 is a failure, not healthy", async () => {
    const outcome = await outcomeOf();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detail).toContain("rate limit exhausted");
      expect(outcome.detail).toContain("x-ratelimit-remaining: 0");
    }
  });

  test("a 403 with quota remaining stays healthy-but-unauthenticated", async () => {
    const outcome = await Effect.runPromise(
      ambientGitHubReachable({
        fetchImpl: () =>
          Promise.resolve(
            jsonResponse(403, { "x-ratelimit-remaining": "58" })
          ) as Promise<Response>,
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ detail: error.detail, ok: false as const }),
          onSuccess: (ok) => ({ ok: true as const, scopes: ok.scopes }),
        })
      )
    );
    // The honest answer on a host whose proxy attaches a scope-less
    // credential: reachable, nothing to alert about.
    expect(outcome.ok).toBe(true);
  });

  test("a plain 401 (no rate-limit header at all) stays healthy", async () => {
    const outcome = await Effect.runPromise(
      ambientGitHubReachable({
        fetchImpl: () =>
          Promise.resolve(jsonResponse(401)) as Promise<Response>,
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ detail: error.detail, ok: false as const }),
          onSuccess: (ok) => ({ ok: true as const, scopes: ok.scopes }),
        })
      )
    );
    expect(outcome.ok).toBe(true);
  });

  test("a 429 (secondary rate limit) is a failure too — it also blocks every call", async () => {
    const outcome = await Effect.runPromise(
      ambientGitHubReachable({
        fetchImpl: () =>
          Promise.resolve(jsonResponse(429)) as Promise<Response>,
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ detail: error.detail, ok: false as const }),
          onSuccess: (ok) => ({ ok: true as const, scopes: ok.scopes }),
        })
      )
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detail).toContain("429");
    }
  });
});
