import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { ghAuthHealthCheck, HealthCheckError, renderHealthAlert } from "./gh-auth-health.ts";

/**
 * Regression: in App mode every failed round-trip paged the same remedy,
 * "GitHub auth is not working … check that the host is injecting and
 * rotating GH_TOKEN … and the App's installation/repo access". A rate limit
 * (403 with `x-ratelimit-remaining: 0`, a 429, a secondary-limit 403) means
 * GitHub accepted the token, and a timeout, refused connection or 5xx means
 * it never judged the token at all, so that remedy sent the operator to
 * rotate a working token. The ambient alert already split these (#395); the
 * App-mode alert now does too, and keeps the auth remedy for 401/403/404.
 */

const AUTH_REMEDY = "Check that the host is injecting and rotating `GH_TOKEN`";

const roundTripFailure = (answer: () => Promise<Response>): Promise<HealthCheckError> =>
  Effect.runPromise(
    Effect.flip(
      ghAuthHealthCheck({
        fetchImpl: answer,
        mint: Effect.succeed({ token: "t" }),
        repo: "acme/widgets",
      })
    )
  );

const rateLimitAnswers: Record<string, () => Promise<Response>> = {
  "403 with x-ratelimit-remaining: 0": async () =>
    new Response(JSON.stringify({ message: "API rate limit exceeded for installation ID 1." }), {
      headers: { "x-ratelimit-remaining": "0" },
      status: 403,
    }),
  "429": async () => new Response("{}", { status: 429 }),
  "403 secondary rate limit": async () =>
    new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit." }), {
      status: 403,
    }),
  "403 with retry-after": async () =>
    new Response("{}", { headers: { "retry-after": "60" }, status: 403 }),
};

const unreachableAnswers: Record<string, () => Promise<Response>> = {
  "503": async () => new Response("<html>unicorn</html>", { status: 503 }),
  "502": async () => new Response("", { status: 502 }),
  "refused connection": () => Promise.reject(new Error("ECONNREFUSED")),
};

const authAnswers: Record<string, () => Promise<Response>> = {
  "401 bad credentials": async () =>
    new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }),
  "403 resource not accessible": async () =>
    new Response(JSON.stringify({ message: "Resource not accessible by integration" }), {
      status: 403,
    }),
  "404 not found": async () =>
    new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
};

describe("the App-mode alert names the remedy that fits the round-trip failure", () => {
  for (const [label, answer] of Object.entries(rateLimitAnswers)) {
    test(`a ${label} alert points at the request budget, never token rotation`, async () => {
      const failure = await roundTripFailure(answer);
      expect(failure.kind).toBe("rate-limited");
      const alert = renderHealthAlert("acme/widgets", failure);
      expect(alert).toContain("rate limited");
      expect(alert).not.toContain(AUTH_REMEDY);
    });
  }

  for (const [label, answer] of Object.entries(unreachableAnswers)) {
    test(`a ${label} alert says the token was never tested`, async () => {
      const failure = await roundTripFailure(answer);
      expect(failure.kind).toBe("unreachable");
      const alert = renderHealthAlert("acme/widgets", failure);
      expect(alert).toContain("never tested");
      expect(alert).not.toContain(AUTH_REMEDY);
    });
  }

  for (const [label, answer] of Object.entries(authAnswers)) {
    test(`a ${label} alert keeps the auth remedy`, async () => {
      const failure = await roundTripFailure(answer);
      expect(failure.kind).toBeUndefined();
      expect(renderHealthAlert("acme/widgets", failure)).toContain(AUTH_REMEDY);
    });
  }

  test("a mint failure keeps the auth remedy", () => {
    const alert = renderHealthAlert(
      "acme/widgets",
      new HealthCheckError({ detail: "GH_TOKEN is not set", stage: "mint" })
    );
    expect(alert).toContain("token mint");
    expect(alert).toContain(AUTH_REMEDY);
  });
});
