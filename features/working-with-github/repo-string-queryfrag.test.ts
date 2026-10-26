import { describe, expect, test } from "bun:test";
// Regression: a QUERY/FRAGMENT suffix (`o/r?tab=readme`, `o/r#anchor` — a
// browser address-bar copy-paste of the repo page, whose tab the browser was
// on rides along) and a BARE-HOST spelling (`https://github.com`,
// `github.com`, `git@github.com`, `ssh://git@github.com` — a copied landing
// page or a truncated `git remote -v` paste, with NO owner and NO repo
// segment at all) are two GITHUB_REPO spelling classes every OTHER paste
// corpus this feature pins has a resolver branch for — and pre-fix all four
// resolvers passed both straight through:
//
//   resolveRepoFromEnv("o/r?tab=readme")          → "o/r?tab=readme"
//   resolveRepoFromEnv("https://github.com")      → "https://github.com"
//   orgOf("https://github.com")                   → "https://github.com"
//   resolveAllowedOrgs(GITHUB_REPO: "github.com") → {"github.com"}
//   resolveConfigDirName(GITHUB_REPO: "…github.com") → "https-github.com"/…
//
// The query/fragment half breaks every consumer the resolvers feed: the
// prompt's recipes interpolate `$REPO` into `repos/{repo}` (the `?` ends the
// PATH — GitHub answers 404 for a repo named `o/r?tab=readme`), the
// `github.com/${REPO}.git` fetch URL (git appends `/info/refs` past the
// fragment; `git ls-remote` never resolves — verified live), and the worktree
// SLUG (`o-r?tab=readme`) the cleanup sweep then scopes to — while
// `resolveConfigDirName` keyed the registry/cache DB on `r-tab-readme`. The
// bare-host half 404s every `repos/{repo}` route the same way (verified live:
// `repos/https://github.com` is no route) and keyed the config dir on the
// sanitized host string. Both classes make the four resolvers silently
// disagree on one spelling, violating the one-spelling contract the README
// states ("every resolver in this feature tolerates the other spellings
// too") and the parity suites pin corpus by corpus.
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

/** A `?query` or `#fragment` suffix never survives into any resolver's answer. */
const QUERY_FRAGMENT_SPELLINGS: readonly string[] = [
  "o/r?tab=readme",
  "o/r#anchor",
  "https://github.com/o/r?tab=readme",
  "https://github.com/o/r#frag",
  "git@github.com:o/r?tab=readme",
];

/** A bare github.com host (no owner, no repo segment) names neither. */
const BARE_HOST_SPELLINGS: readonly string[] = [
  "https://github.com",
  "github.com",
  "git@github.com",
  "ssh://git@github.com",
  "https://github.com/",
  "https://github.com:443",
  "github.com:22",
  "git@github.com:22",
  "ssh://git@github.com:22",
];

describe("a query/fragment suffix resolves to the repo, never the suffix", () => {
  test("resolveRepoFromEnv strips the suffix", () => {
    for (const raw of QUERY_FRAGMENT_SPELLINGS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("o/r");
    }
  });

  test("orgOf strips the suffix", () => {
    expect(orgOf("o/r?tab=readme")).toBe("o");
    expect(orgOf("o/r#anchor")).toBe("o");
    expect(orgOf("https://github.com/orgs/acme?x")).toBe("acme");
    expect(orgOf("https://github.com/orgs/acme#frag")).toBe("acme");
  });

  test("the allowlist keys on the owner, never the raw suffix", () => {
    for (const raw of QUERY_FRAGMENT_SPELLINGS) {
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw })]).toEqual(
        ["o"]
      );
    }
  });

  test("the config dir keys on the repo name, never the sanitized suffix", () => {
    for (const raw of QUERY_FRAGMENT_SPELLINGS) {
      expect(resolveConfigDirName({ GITHUB_REPO: raw, INTERN_NAME: "" })).toBe(
        "r"
      );
    }
  });
});

describe("a bare-host spelling resolves to no owner/repo in every resolver", () => {
  test("resolveRepoFromEnv answers the honest empty value", () => {
    for (const raw of BARE_HOST_SPELLINGS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("");
    }
  });

  test("orgOf answers no org", () => {
    for (const raw of BARE_HOST_SPELLINGS) {
      expect(orgOf(raw)).toBe("");
    }
  });

  test("the allowlist derives no login from the host word", () => {
    for (const raw of BARE_HOST_SPELLINGS) {
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw })]).toEqual(
        []
      );
    }
  });

  test("the config dir keeps its documented no-repo fallback", () => {
    for (const raw of BARE_HOST_SPELLINGS) {
      expect(
        resolveConfigDirName({ GITHUB_REPO: raw, INTERN_NAME: "" })
      ).toBe("intern");
    }
  });

  test("a login-carrying spelling under the same host still resolves", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: "github.com:acme" })).toBe(
      "acme"
    );
    expect(orgOf("github.com:acme")).toBe("acme");
    expect([
      ...resolveAllowedOrgs(undefined, { GITHUB_REPO: "github.com:acme" }),
    ]).toEqual(["acme"]);
    expect(
      resolveConfigDirName({ GITHUB_REPO: "github.com:acme", INTERN_NAME: "" })
    ).toBe("acme");
  });
});