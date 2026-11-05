import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { AmbientProbeError, ambientGitHubReachable, renderAmbientAlert } from "./gh-auth-health.ts";

/**
 * Regression: with no GITHUB_REPO the ambient probe asks the unscoped root
 * `GET /`, which a per-owner proxy never credentials, so it rides the shared
 * anonymous 60/h limit. Reproduced live on an ambient workspace with no
 * GITHUB_REPO (2026-11-05): the root answered 403 `x-ratelimit-remaining: 0`
 * while `GET /repos/<owner>/<repo>` answered 200, and the probe failed with
 * "every GitHub REST call fails until the limit resets" and a remedy to "find
 * what is spending the request budget". Both claims were false: every
 * owner-scoped call worked. The root failure now says what it shows (calls
 * without a credential fail) and names the remedy that lets the probe
 * see real access: set GITHUB_REPO.
 */

const anonymousRootExhausted = (): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      headers: { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0" },
      status: 403,
    })
  );

const failureOf = (repo: string): Promise<AmbientProbeError> =>
  Effect.runPromise(
    Effect.flip(ambientGitHubReachable({ fetchImpl: anonymousRootExhausted, repo }))
  );

describe("an exhausted unscoped root never claims every GitHub call fails", () => {
  test("with no repo, the failure is marked unscoped and drops the every-call claim", async () => {
    const failure = await failureOf("");
    expect(failure.rateLimited).toBeTrue();
    expect(failure.unscoped).toBeTrue();
    expect(failure.detail).toContain("GET /");
    expect(failure.detail).toContain("x-ratelimit-remaining: 0");
    expect(failure.detail).not.toContain("every GitHub REST call fails");
  });

  test("with no repo, the alert names GITHUB_REPO, not the request budget", async () => {
    const alert = renderAmbientAlert(await failureOf(""));
    expect(alert).toContain("Set `GITHUB_REPO`");
    expect(alert).not.toContain("find what is spending the request budget");
    expect(alert).not.toContain("unreachable");
  });

  test("the unscoped 429 and secondary-limit 403 take the same alert", async () => {
    for (const answer of [
      new Response("{}", { status: 429 }),
      new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit." }), {
        status: 403,
      }),
    ]) {
      const failure = await Effect.runPromise(
        Effect.flip(ambientGitHubReachable({ fetchImpl: () => Promise.resolve(answer) }))
      );
      expect(failure.unscoped).toBeTrue();
      expect(renderAmbientAlert(failure)).toContain("Set `GITHUB_REPO`");
    }
  });

  test("an exhausted owner-scoped route keeps the every-call claim and the budget remedy", async () => {
    const failure = await failureOf("acme/widgets");
    expect(failure.unscoped).toBeUndefined();
    expect(failure.detail).toContain("every GitHub REST call fails");
    expect(renderAmbientAlert(failure)).toContain("find what is spending the request budget");
  });
});
