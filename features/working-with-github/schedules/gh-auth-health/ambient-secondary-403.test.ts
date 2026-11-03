import { describe, expect, test } from "bun:test";
// Regression: GitHub answers a secondary rate limit with HTTP 403 as often as
// with 429, and with primary quota still remaining. The probe failed only on
// a 429 or a 403 with `x-ratelimit-remaining: 0`, so that 403 logged
// "ok — GitHub API reachable" while every REST call failed. It is told apart
// from an auth 403 by a `retry-after` header or a message naming the limit.
import { Effect } from "effect";

import { ambientGitHubReachable } from "./gh-auth-health.ts";

const probe = (response: Response) =>
  Effect.runPromise(
    ambientGitHubReachable({
      fetchImpl: () => Promise.resolve(response),
      repo: "acme/widgets",
    }).pipe(
      Effect.match({
        onFailure: (error) => ({ detail: error.detail, ok: false as const }),
        onSuccess: () => ({ detail: "", ok: true as const }),
      })
    )
  );

const secondaryMessage =
  "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.";

describe("the ambient probe reads a 403 secondary rate limit as a failure", () => {
  test("a 403 naming the secondary rate limit fails, with quota remaining", async () => {
    const outcome = await probe(
      Response.json(
        { message: secondaryMessage },
        { headers: { "x-ratelimit-remaining": "4990" }, status: 403 }
      )
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("secondary rate limit");
    expect(outcome.detail).toContain("GET /repos/acme/widgets");
  });

  test("a 403 carrying retry-after fails too", async () => {
    const outcome = await probe(
      Response.json(
        { message: "boom" },
        { headers: { "retry-after": "60" }, status: 403 }
      )
    );
    expect(outcome.ok).toBe(false);
  });

  test("an auth 403 stays healthy", async () => {
    const outcome = await probe(
      Response.json(
        { message: "Resource not accessible by integration" },
        { headers: { "x-ratelimit-remaining": "58" }, status: 403 }
      )
    );
    expect(outcome.ok).toBe(true);
  });

  test("a 403 whose body errors mid-read stays healthy", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    const outcome = await probe(new Response(body, { status: 403 }));
    expect(outcome.ok).toBe(true);
  });

  test("a 403 whose body is not JSON stays healthy", async () => {
    const outcome = await probe(new Response("<html>forbidden</html>", { status: 403 }));
    expect(outcome.ok).toBe(true);
  });
});
