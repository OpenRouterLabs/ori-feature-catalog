import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";

import { resolveRepoFromEnv } from "@ori-monorepo/working-with-github/commit-api-core.ts";

import { AmbientProbeError, ambientGitHubReachable, renderAmbientAlert } from "./gh-auth-health.ts";

/**
 * Regression: when GITHUB_REPO is SET to a spelling that resolves to no
 * owner/repo (`https://github.com/orgs`, the organizations index), the probe
 * falls back to the unscoped root, and an exhausted root paged "`GITHUB_REPO`
 * is not set … Set `GITHUB_REPO`". The operator who set it is told to set it.
 * The App-mode branch already tells the two causes apart ("resolves to no
 * owner/repo — check its spelling"); the ambient alert now does too.
 *
 * schedule.ts is not imported (its `ori` SDK is absent on a fresh checkout);
 * its wiring is pinned by source text, like schedule-repo-resolver.test.ts.
 */

const exhaustedRoot = (): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      headers: { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0" },
      status: 403,
    })
  );

const SET_BUT_UNRESOLVABLE = "https://github.com/orgs";

const rootFailure = (): Promise<AmbientProbeError> =>
  Effect.runPromise(
    Effect.flip(
      ambientGitHubReachable({
        fetchImpl: exhaustedRoot,
        repo: resolveRepoFromEnv({ GITHUB_REPO: SET_BUT_UNRESOLVABLE }),
      })
    )
  );

describe("an exhausted root with GITHUB_REPO set but unresolvable", () => {
  test("the spelling really resolves to no repo, so the probe asks the root", async () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: SET_BUT_UNRESOLVABLE })).toBe("");
    expect((await rootFailure()).unscoped).toBeTrue();
  });

  test("the alert names the set value and its spelling, never 'not set'", async () => {
    const alert = renderAmbientAlert(await rootFailure(), SET_BUT_UNRESOLVABLE);
    expect(alert).not.toContain("is not set");
    expect(alert).not.toContain("Set `GITHUB_REPO`");
    expect(alert).toContain(`"${SET_BUT_UNRESOLVABLE}"`);
    expect(alert).toContain("resolves to no owner/repo");
  });

  test("an unset GITHUB_REPO keeps the set-it remedy", async () => {
    expect(renderAmbientAlert(await rootFailure())).toContain("Set `GITHUB_REPO`");
    expect(renderAmbientAlert(await rootFailure(), "")).toContain("Set `GITHUB_REPO`");
  });

  test("the schedule passes the redacted raw GITHUB_REPO to the ambient alert", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "schedule.ts"),
      "utf-8"
    );
    expect(source).toMatch(
      /renderAmbientAlert\(\s*failure,[\s\S]{0,200}?redactUserinfo\(\(process\.env\.GITHUB_REPO \?\? ""\)\.trim\(\)\)\s*\)/u
    );
  });
});
