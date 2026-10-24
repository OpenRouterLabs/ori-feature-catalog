import { describe, expect, test } from "bun:test";
// A bare host+PORT spelling (`github.com:22`, `git@github.com:22` — a truncated
// `git remote -v` copy-paste) and a port+ORG spelling (`github.com:22/acme`)
// are repo strings the resolvers normalized INCONSISTENTLY after #186: `orgOf`
// strips the port up front, but `resolveRepoFromEnv` and `resolveAllowedOrgs`
// left it in, so the optional `(?::\d+)?` port group let the bare `[/:]` host
// separator BACKTRACK — the colon itself became the separator and the port
// DIGITS became the owner/repo segment:
//   resolveRepoFromEnv("github.com:22")    → "22"      (a repo string no route answers)
//   resolveRepoFromEnv("github.com:22/acme") → "22/acme" (the fake owner/repo pair)
//   resolveAllowedOrgs("github.com:22/acme") → ["22"]  (an allowlist login no installation owns,
//                                                       so every mint fails closed)
// The registry key meanwhile resolved to "acme" — the same spelling silently
// disagreed across the resolvers whose parity the README promises ("every
// resolver in this feature tolerates the other spellings too"). This pins the
// same fix shape orgOf already carries: strip an unambiguous `:<digits>` port
// right after the `github.com` host before any regex runs.
import { orgOf } from "./gh-app-registry.ts";
import { resolveAllowedOrgs, isAllowlistedOrg } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

describe("a bare host+port spelling never yields the port digits", () => {
  test("resolveRepoFromEnv passes the host word through, not \"22\"", () => {
    // No org/repo segment follows the port, so there is nothing to invent: the
    // resolver returns the same value orgOf does for the spelling, instead of
    // the port digits.
    expect(resolveRepoFromEnv({ GITHUB_REPO: "github.com:22" })).toBe(
      orgOf("github.com:22")
    );
    expect(resolveRepoFromEnv({ GITHUB_REPO: "git@github.com:22" })).toBe(
      orgOf("git@github.com:22")
    );
  });
  test("the allowlist keys on the host word too, so no resolver splits", () => {
    const allowed = resolveAllowedOrgs(undefined, {
      GITHUB_REPO: "github.com:22",
    });
    expect(Array.from(allowed)).toEqual([orgOf("github.com:22")]);
  });
});

describe("a port+org spelling resolves to its org in every resolver", () => {
  test("resolveRepoFromEnv keeps the org, not the port digits", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: "github.com:22/acme" })).toBe(
      "acme"
    );
    expect(resolveRepoFromEnv({ GITHUB_REPO: "git@github.com:22/acme" })).toBe(
      "acme"
    );
  });
  test("the allowlist carries the org, so a mint does not fail closed", () => {
    const allowed = resolveAllowedOrgs(undefined, {
      GITHUB_REPO: "github.com:22/acme",
    });
    expect(isAllowlistedOrg("acme", allowed)).toBe(true);
    expect(isAllowlistedOrg("22", allowed)).toBe(false);
  });
  test("orgOf already resolved the spelling to the org (the parity anchor)", () => {
    expect(orgOf("github.com:22/acme")).toBe("acme");
  });
});
