import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { ambientGitHubReachable, renderAmbientAlert } from "./gh-auth-health.ts";

/**
 * Regression: the ambient probe logged "ok — GitHub API reachable" on a 401.
 * GitHub never answers 401 to a request that carries no credential on the
 * probe's routes: an anonymous `GET /` is 200 and an anonymous
 * `GET /repos/{owner}/{repo}` is 200, or 404 for a private repo. A 401 there
 * means a credential WAS attached and refused: GitHub's "Bad credentials", or
 * the host's own refusal of the credential it holds. Reproduced live
 * (2026-11-06) through an egress proxy: a refused credential on
 * `GET /repos/octocat/Hello-World` answered 401 "Bad credentials", and the
 * proxy's own credential refusals answer 401 too. That is the one state
 * the ambient check exists to catch, and it was paged as healthy. 403 and
 * 404 stay healthy: those are the honest answers of a host that attaches no
 * credential.
 */

const answer401 = (message: string) => (): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify({ message }), { status: 401 }));

describe("an ambient 401 is a refused credential, never health", () => {
  for (const repo of ["acme/widgets", ""]) {
    test(`a 401 on ${repo === "" ? "the root" : "the repo route"} fails the probe naming the refusal`, async () => {
      const failure = await Effect.runPromise(
        Effect.flip(ambientGitHubReachable({ fetchImpl: answer401("Bad credentials"), repo }))
      );
      expect(failure.refused).toBeTrue();
      expect(failure.rateLimited).toBeUndefined();
      expect(failure.detail).toContain("HTTP 401");
      expect(failure.detail).toContain("Bad credentials");
    });
  }

  test("the alert names the refused credential, not the network or the budget", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        ambientGitHubReachable({ fetchImpl: answer401("Bad credentials"), repo: "acme/widgets" })
      )
    );
    const alert = renderAmbientAlert(failure);
    expect(alert).toContain("refused");
    expect(alert).not.toContain("unreachable");
    expect(alert).not.toContain("request budget");
  });

  test("a 401 with no readable body still fails, on the status alone", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        ambientGitHubReachable({
          fetchImpl: () => Promise.resolve(new Response("<html>nope</html>", { status: 401 })),
          repo: "acme/widgets",
        })
      )
    );
    expect(failure.refused).toBeTrue();
    expect(failure.detail).toContain("HTTP 401");
  });

  for (const status of [403, 404]) {
    test(`a plain ${status} stays healthy`, async () => {
      const ok = await Effect.runPromise(
        ambientGitHubReachable({
          fetchImpl: () =>
            Promise.resolve(new Response(JSON.stringify({ message: "Not Found" }), { status })),
          repo: "acme/widgets",
        })
      );
      expect(ok.mode).toBe("ambient");
    });
  }
});
