import { describe, expect, test } from "bun:test";
// A host's egress proxy attaches the workspace credential PER OWNER: a route
// that names an owner it reaches (`/repos/{owner}/{repo}`, `/orgs/{owner}`)
// goes out credentialed, while an unscoped route (`GET /`, `/rate_limit`)
// names no owner and goes out ANONYMOUSLY, on the shared 60/h bucket.
// Reproduced live on an ambient workspace (2026-11-01): `GET /` answered
// 403 with `x-ratelimit-limit: 60` / `x-ratelimit-remaining: 0` while
// `GET /repos/<owner>/<repo>` answered 200 on a 15000/h credential. Pre-fix
// the probe only ever called `GET /`, so it reported "rate limit exhausted —
// every GitHub REST call fails" (and paged the alert channel) while every
// owner-scoped call the intern actually makes worked. The probe now asks the
// intern's own repo — the route real work uses — whenever GITHUB_REPO
// resolves, and keeps the root only when there is no repo to ask about.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";

import { ambientGitHubReachable } from "./gh-auth-health.ts";

/** The vault-proxy shape: owner-scoped routes credentialed, the root anonymous and exhausted. */
const perOwnerProxy = (calls: string[]) => (url: string): Promise<Response> => {
  calls.push(url);
  return Promise.resolve(
    url === "https://api.github.com/"
      ? new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          headers: { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0" },
          status: 403,
        })
      : new Response(JSON.stringify({ full_name: "acme/widgets" }), {
          headers: { "x-ratelimit-limit": "15000", "x-ratelimit-remaining": "14998" },
          status: 200,
        })
  );
};

const outcomeOf = (input: Parameters<typeof ambientGitHubReachable>[0]) =>
  Effect.runPromise(
    ambientGitHubReachable(input).pipe(
      Effect.match({
        onFailure: (error) => ({ detail: error.detail, ok: false as const }),
        onSuccess: () => ({ ok: true as const }),
      })
    )
  );

describe("the ambient probe asks an owner-scoped route, not the anonymous root", () => {
  test("with a repo, the probe calls GET /repos/{repo} and an exhausted anonymous root raises no alarm", async () => {
    const calls: string[] = [];
    const outcome = await outcomeOf({ fetchImpl: perOwnerProxy(calls), repo: "acme/widgets" });
    expect(calls).toEqual(["https://api.github.com/repos/acme/widgets"]);
    expect(outcome.ok).toBe(true);
  });

  test("an exhausted owner-scoped route is still the failure it always was, naming the route", async () => {
    const outcome = await outcomeOf({
      fetchImpl: () =>
        Promise.resolve(
          new Response("{}", { headers: { "x-ratelimit-remaining": "0" }, status: 403 })
        ),
      repo: "acme/widgets",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detail).toContain("GET /repos/acme/widgets");
      expect(outcome.detail).toContain("rate limit exhausted");
    }
  });

  test("with no repo (empty or omitted), the probe keeps the root", async () => {
    for (const repo of ["", undefined]) {
      const calls: string[] = [];
      await outcomeOf({ fetchImpl: perOwnerProxy(calls), ...(repo === undefined ? {} : { repo }) });
      expect(calls).toEqual(["https://api.github.com/"]);
    }
  });

  test("the schedule hands the probe the resolved GITHUB_REPO", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "schedule.ts"),
      "utf-8"
    );
    expect(source).toMatch(/ambientGitHubReachable\(\{\s*repo: resolveRepoFromEnv\(process\.env\)/u);
  });

  test("the prompt's ambient-mode detection probes an owner-scoped route, never the bare root", () => {
    const prompt = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompt.md"),
      "utf-8"
    );
    expect(prompt).not.toContain("If a `curl` to `https://api.github.com/` succeeds");
    expect(prompt).toContain("If a `curl` to an owner-scoped route");
  });
});
