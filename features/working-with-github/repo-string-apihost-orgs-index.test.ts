import { describe, expect, test } from "bun:test";
// An api.github.com paste of the ORGANIZATIONS-page INDEX —
// `api.github.com/orgs` (also `/organizations`, `/users`, and the
// schemed/ported/case-variant/user-info/leading-slash forms of the same
// URL) — is the same "lists your organizations" page whose github.com
// spelling all four resolvers already answer with the honest no-owner
// value (#203/#204). The api strip removes the host and hands the branches
// below the bare reserved word `orgs`, which every org-NAMING branch
// misses (they need a segment past the word), so pre-fix the word itself
// flowed on as the "owner"/"repo" — a login and a repo no GitHub route
// answers (`orgs` is a reserved host path, verified live: `orgs/repos`
// 404s) — while every sibling spelling of the same page answered ""/[]
// /"intern". One spelling, five surfaces (orgOf, resolveRepoFromEnv,
// resolveAllowedOrgs, resolveConfigDirName, the REPO= recipe), one
// contract.
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

/** Every api-paste spelling of the organizations-page INDEX. */
const INDEX_SPELLINGS: readonly string[] = [
  "api.github.com/orgs",
  "https://api.github.com/orgs",
  "api.github.com/organizations",
  "https://api.github.com/organizations",
  "api.github.com/users",
  "https://api.github.com/users",
  // A trailing slash is the same page (the tail strips remove it before
  // the guard; pinned so the guard's optional-trailing-slash tolerance is
  // honest).
  "api.github.com/orgs/",
  // The ported, case-variant, user-info, and leading-slash forms of the
  // same URL — the spellings the sibling api strips already tolerate.
  "api.github.com:443/orgs",
  "API.GitHub.com/orgs",
  "ssh://git@api.github.com/orgs",
  "https://deploy@api.github.com/orgs",
  "//api.github.com/orgs",
];

describe("an api.github.com organizations-index paste resolves to no owner", () => {
  test("orgOf answers the no-owner value for every index spelling", () => {
    for (const spelling of INDEX_SPELLINGS) {
      expect(orgOf(spelling)).toBe("");
    }
  });

  test("resolveRepoFromEnv answers no repo for every index spelling", () => {
    for (const spelling of INDEX_SPELLINGS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe("");
    }
  });

  test("resolveAllowedOrgs derives no login from every index spelling", () => {
    for (const spelling of INDEX_SPELLINGS) {
      expect(
        Array.from(resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling }))
      ).toEqual([]);
    }
  });

  test("resolveConfigDirName takes the documented no-repo fallback", () => {
    for (const spelling of INDEX_SPELLINGS) {
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe("intern");
    }
  });

  // Guards: the org-NAMING spellings keep deriving their org, and the
  // github.com index spellings keep their existing answers.
  test("the org-naming api spellings still resolve to their org", () => {
    expect(orgOf("api.github.com/orgs/acme")).toBe("acme");
    expect(orgOf("https://api.github.com/organizations/acme/teams")).toBe(
      "acme"
    );
    expect(resolveRepoFromEnv({ GITHUB_REPO: "api.github.com/orgs/acme" })).toBe(
      "acme"
    );
  });

  test("the github.com index spellings are unchanged", () => {
    expect(orgOf("github.com/orgs")).toBe("");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "github.com/orgs" })).toBe("");
  });
});
