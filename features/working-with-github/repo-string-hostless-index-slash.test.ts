import { describe, expect, test } from "bun:test";
// Regression: the HOSTLESS index spellings with a LEADING slash —
// `/organizations`, `//organizations` (and `  /organizations`, a paste with
// padding) — are the same organizations-page INDEX paste the bare word is
// (`#203/#204`), reopened through the leading slash every sibling resolver
// already strips (`#208`). Pre-fix the four resolvers disagreed on one
// spelling, exactly the shape the README's one-spelling contract forbids:
//
//   - `resolveRepoFromEnv` said "" (its leading-slash strip runs first, so
//     the anchored `^organizations$` guard fired);
//   - `orgOf` said "organizations" — its `^organizations$` guard tests
//     `cleaned`, a value computed BEFORE the leading-slash strip, so the
//     slash made the anchor miss and the bare pass-through at the bottom
//     returned the word WITH the slash trimmed off by the final
//     `login.trim().toLowerCase()` at the comparison sites — a registry key
//     and an allowlist entry no mint can ever derive from a real repo
//     string;
//   - `resolveAllowedOrgs` said ["organizations"] — the fail-closed allowlist
//     keyed on a login no installation can ever own, so every mint failed
//     closed with no hint the spelling was the cause;
//   - `resolveConfigDirName` said "organizations" — the registry/cache DB
//     silently migrated to `~/.config/organizations/` the moment the env
//     var's spelling gained a leading slash, orphaning every row already
//     written (#113's class).
//
// The prompt's REPO= recipe answers "" for every one of these spellings (it
// strips leading slashes first), and `resolveRepoFromEnv` already agrees —
// the other three must match. The org-NAMING spellings (`orgs/<org>`) and a
// bare `orgs` word keep their existing behavior.

import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";

const HOSTLESS_INDEX_SLASH: readonly string[] = [
  "/organizations",
  "//organizations",
  "  /organizations",
];

describe("a leading-slash hostless index spelling resolves like the bare word", () => {
  test("orgOf returns the empty string, never the reserved word", () => {
    for (const spelling of HOSTLESS_INDEX_SLASH) {
      expect(orgOf(spelling)).toBe("");
    }
  });

  test("resolveRepoFromEnv agrees — the empty string for every spelling", () => {
    for (const spelling of HOSTLESS_INDEX_SLASH) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe("");
    }
  });

  test("resolveAllowedOrgs is empty, so every mint fails closed honestly", () => {
    for (const spelling of HOSTLESS_INDEX_SLASH) {
      expect([
        ...resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling }),
      ]).toEqual([]);
    }
  });

  test("resolveConfigDirName falls back to intern, never the reserved word", () => {
    for (const spelling of HOSTLESS_INDEX_SLASH) {
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe("intern");
    }
  });
});

describe("the neighboring spellings keep their existing behavior", () => {
  test("the org-NAMING spelling with a leading slash still resolves to the org", () => {
    // `orgs/acme` and `/orgs/acme` both name the org; the leading slash on
    // the org-naming form must not change what it resolves to.
    expect(orgOf("orgs/acme")).toBe("acme");
    expect(orgOf("/orgs/acme")).toBe("acme");
    expect(orgOf("//orgs/acme")).toBe("acme");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "/orgs/acme" })).toBe("acme");
    expect([
      ...resolveAllowedOrgs(undefined, { GITHUB_REPO: "/orgs/acme" }),
    ]).toEqual(["acme"]);
    expect(resolveConfigDirName({ GITHUB_REPO: "/orgs/acme" })).toBe("acme");
  });

  test("a bare orgs word keeps its pass-through, slash or no slash", () => {
    // A login spelled `orgs` keeps the bare-owner pass-through in every
    // form — the org-NAMING branch consumes the reserved-word reading
    // whenever a second segment exists.
    expect(orgOf("orgs")).toBe("orgs");
    expect(orgOf("/orgs")).toBe("orgs");
    expect(orgOf("//orgs")).toBe("orgs");
  });

  test("the hosted index spelling is unchanged", () => {
    expect(orgOf("https://github.com/organizations")).toBe("");
    expect(orgOf("https://github.com/orgs")).toBe("");
  });
});
