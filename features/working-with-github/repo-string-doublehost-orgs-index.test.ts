import { describe, expect, test } from "bun:test";
// An ORGANIZATIONS-page INDEX spelling that rides PAST a first host word —
// `github.com:github.com/orgs`, `github.com:github.com/users`,
// `github.com:api.github.com/orgs` (a paste whose tail carries a SECOND host
// word ahead of the reserved one) — names no owner: it is the orgs INDEX,
// the page that LISTS organizations, and `orgOf` and `resolveRepoFromEnv`
// already answer "" for it (the orgs-index guard runs on the unanchored
// LAST-host word, exactly the reading prompt-recipes-orgs-host-org pins for
// `x/github.com/users` → ""). But `resolveAllowedOrgs`' own repo match
// (`github.com[/:]([^/]+)/[^/]+`, also unanchored, also LAST-host) reads the
// SECOND host word as the owner and keyed the allowlist on the host string
// itself (`github.com`, `api.github.com`) — a login no installation owner can
// ever carry, so EVERY mint failed closed with no hint the env var's
// spelling was the cause, while `orgOf` answered "" and
// `resolveRepoFromEnv` answered "" for the same spelling. One spelling, the
// resolvers disagreeing — the README's one-spelling contract.
//
// Fix: `resolveAllowedOrgs` derives its repo-source owner through the same
// `orgOf` reading the registry and the Git-Data paths use — the orgs-index
// tail then names no owner and the allowlist honestly falls through to its
// other sources, exactly like every sibling resolver.
import { orgOf } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

/** Orgs-index tails riding past a first host word — all no-owner spellings. */
const DOUBLE_HOST_INDEX: readonly string[] = [
  "github.com:github.com/orgs",
  "github.com:github.com/users",
  "github.com:github.com/organizations",
  "github.com:api.github.com/orgs",
  "github.com:api.github.com/users",
  "x/github.com/orgs",
  "x/github.com/users",
];

describe("an orgs-index tail riding past a first host word names no allowlist owner", () => {
  test("every resolver answers no owner for the double-host index spellings", () => {
    for (const spelling of DOUBLE_HOST_INDEX) {
      expect(orgOf(spelling)).toBe("");
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe("");
      expect([
        ...resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling }),
      ]).toEqual([]);
    }
  });

  test("the org-naming tails keep their owners (corpus guard)", () => {
    for (const [spelling, org] of [
      ["github.com:github.com/orgs/acme", "acme"],
      ["git@github.com:github.com/users/bob", "bob"],
      ["x/github.com/orgs/acme", "acme"],
      ["github.com/orgs/acme", "acme"],
    ] as const) {
      expect(orgOf(spelling)).toBe(org);
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe(org);
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling })]).toEqual([org]);
    }
  });
});
