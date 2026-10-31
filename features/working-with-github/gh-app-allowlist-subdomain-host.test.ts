import { describe, expect, test } from "bun:test";

import { orgOf } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

// Regression: a SUBDOMAIN host word riding a first `github.com` host into a
// reserved index path — `git@github.com:www.github.com/orgs`,
// `github.com:22:gist.github.com/users` — made `resolveAllowedOrgs` key the
// allowlist on the subdomain host word (`www.github.com`, a login no
// installation owner can ever carry) while `orgOf` and `resolveRepoFromEnv`
// answered the honest `""` for the same spelling.
//
// Root cause: `repoMatchOwnerIsHost`'s guard
// `/^(?:git@)?(?:[Aa][Pp][Ii]\.)?github\.com$/` tolerated only the bare host
// and the `api.` label — every OTHER subdomain (`www.`, `gist.`,
// `codeload.`) fell the guard, so `repoMatch`'s captured segment (the
// subdomain host word itself) flowed on as the "owner" and keyed the
// allowlist. The guard exists precisely to keep a host word from becoming a
// login (#330's class, pinned by `repo-string-doublehost-orgs-index.test.ts`);
// a subdomain host word is the same shape and must be guarded the same way.
//
// Reachability: a `git remote -v` or address-bar paste whose tail carries a
// subdomain host — the same paste family `repo-string-subdomain-host.test.ts`
// and `prompt-recipes-subdomain-host.test.ts` pin for the bare subdomain
// spellings. One spelling contract, four resolvers: the allowlist must agree
// with `orgOf`/`resolveRepoFromEnv`, and a host word is never an owner.
describe("resolveAllowedOrgs — a subdomain host word behind a first host is never an owner", () => {
  test.each([
    "git@github.com:www.github.com/orgs",
    "git@github.com:www.github.com/users",
    "git@github.com:gist.github.com/organizations",
    "github.com:22:www.github.com/orgs",
    "github.com:api.github.com/users",
    "https://github.com:www.github.com/orgs",
  ])("%s answers no owner, exactly like orgOf and resolveRepoFromEnv", (raw) => {
    expect(orgOf(raw)).toBe("");
    expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("");
    expect(Array.from(resolveAllowedOrgs(undefined, { GITHUB_REPO: raw }))).toEqual(
      []
    );
  });

  test("an explicit override still survives the same spellings (the chain never masks a source)", () => {
    for (const raw of [
      "git@github.com:www.github.com/orgs",
      "github.com:22:gist.github.com/users",
    ]) {
      expect(
        Array.from(resolveAllowedOrgs(["acme-corp"], { GITHUB_REPO: raw }))
      ).toEqual(["acme-corp"]);
    }
  });

  test("the healthy spellings keep their pinned answers (corpus guard)", () => {
    for (const [raw, expected] of [
      ["https://github.com/acme/widgets", ["acme"]],
      ["https://www.github.com/acme/widgets", ["acme"]],
      ["https://api.github.com/repos/acme/widgets", ["acme"]],
      ["github.com:acme/widgets", ["acme"]],
      ["github.com:22/acme/widgets", ["acme"]],
      ["https://github.com/orgs/acme", ["acme"]],
      ["github.com", []],
      ["https://github.com", []],
    ] as const) {
      expect(
        Array.from(resolveAllowedOrgs(undefined, { GITHUB_REPO: raw }))
      ).toEqual([...expected]);
    }
  });
});