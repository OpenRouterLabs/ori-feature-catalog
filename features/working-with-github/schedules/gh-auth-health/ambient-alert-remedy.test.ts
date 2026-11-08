import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";

import { AmbientProbeError, ambientGitHubReachable, renderAmbientAlert } from "./gh-auth-health.ts";

/**
 * Regression: every failed ambient probe paged the same text, "GitHub is
 * unreachable … check the host's egress proxy / network path". A rate-limit
 * refusal (403 with `x-ratelimit-remaining: 0`, a 429, a secondary-limit 403)
 * is an ANSWER from GitHub, so that remedy sent the operator to debug a
 * working network path. The alert now names the request budget for a rate
 * limit and keeps the network remedy for a timeout or a 5xx.
 */

const probeFailure = (response: () => Promise<Response>): Promise<AmbientProbeError> =>
  Effect.runPromise(Effect.flip(ambientGitHubReachable({ fetchImpl: response, repo: "o/r" })));

const rateLimitAnswers: Record<string, () => Promise<Response>> = {
  "403 with x-ratelimit-remaining: 0": async () =>
    new Response("{}", { headers: { "x-ratelimit-remaining": "0" }, status: 403 }),
  "429": async () => new Response("{}", { status: 429 }),
  "403 secondary rate limit": async () =>
    new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit." }), {
      status: 403,
    }),
};

describe("the ambient alert names the remedy that fits the failure", () => {
  for (const [label, answer] of Object.entries(rateLimitAnswers)) {
    test(`a ${label} alert points at the request budget, never the network path`, async () => {
      const alert = renderAmbientAlert(await probeFailure(answer));
      expect(alert).toContain("rate limited");
      expect(alert).not.toContain("unreachable");
      expect(alert).not.toContain("egress proxy");
    });
  }

  test("a 5xx keeps the network remedy", async () => {
    const alert = renderAmbientAlert(
      await probeFailure(async () => new Response("", { status: 502 }))
    );
    expect(alert).toContain("unreachable");
    expect(alert).toContain("egress proxy");
  });

  test("a refused connection keeps the network remedy", async () => {
    const alert = renderAmbientAlert(
      await probeFailure(() => Promise.reject(new Error("ECONNREFUSED")))
    );
    expect(alert).toContain("ECONNREFUSED");
    expect(alert).toContain("egress proxy");
  });

  // Regression: a 5xx or a failed fetch never tested the credential, yet the
  // alert said "ambient (proxy-attached) access is broken" (the live 504 on
  // `GET /` read that way), and a failed fetch's detail was a bare "fetch
  // failed" naming no route.
  for (const status of [500, 503, 504]) {
    test(`a ${status} never claims ambient access is broken and names GitHub's status`, async () => {
      const alert = renderAmbientAlert(
        await probeFailure(async () => new Response("", { status }))
      );
      expect(alert).toContain(`GET /repos/o/r answered HTTP ${status}`);
      expect(alert).not.toContain("ambient (proxy-attached) access is broken");
      expect(alert).toContain("was never tested");
      expect(alert).toContain("GitHub's status");
    });
  }

  test("a failed fetch names the route it asked", async () => {
    const failure = await probeFailure(() => Promise.reject(new TypeError("fetch failed")));
    expect(failure.detail).toBe("GET /repos/o/r failed: fetch failed");
    expect(renderAmbientAlert(failure)).not.toContain("ambient (proxy-attached) access is broken");
  });

  test("the schedule renders the alert from the whole failure", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "schedule.ts"),
      "utf-8"
    );
    expect(source).toMatch(/text: renderAmbientAlert\(\s*failure,/u);
    expect(source).not.toContain("const renderAmbientAlert");
  });
});
