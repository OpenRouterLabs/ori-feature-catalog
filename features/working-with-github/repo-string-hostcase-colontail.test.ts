import { describe, expect, test } from "bun:test";
// A TRUNCATED scp/ssh host word with a CASE-VARIANT host in a NON-LEADING
// position — `acme/GitHub.com:`, `o/r/GitHub.com:`, `acme/API.GitHub.com:`
// (a `git remote -v` paste cut at the colon, riding past a first segment,
// with the host word keeping the address bar's capitalization) — names no
// owner and no repo: the truncated-colon guard `github.com(?::\d+)?:$` and
// the hostless-deep regexes below it key on a case-SENSITIVE host word, so
// the case-variant spelling fell them and each resolver answered a
// different dead value than its own lowercase sibling for the same URL
// (hosts are case-insensitive, RFC 3986 §3.2.2 — the contract
// repo-string-hostcase.test.ts pins for the LEADING host word, and
// repo-string-hostcase-midstring.test.ts for the non-leading one):
//
//   "acme/GitHub.com:"  repo = "acme/GitHub.com:"  org = "acme"
//   "acme/github.com:"  repo = ""                 org = ""
//
// The trailing colon survives into the "repo" (a `repos/{repo}` route 404s
// on it — `repo-string-colon-tail.test.ts` pins the class for the lowercase
// spelling) and `orgOf` answers `acme` while the sibling answers "" — one
// spelling, the resolvers disagreeing with their own lowercase forms, the
// README's one-spelling contract broken through the case dimension of the
// class the colon-tail corpus already pins.
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

/** Truncated-colon tails with a case-variant NON-LEADING host word. */
const CASE_COLON_TAILS: readonly { readonly raw: string; readonly lower: string }[] = [
  { raw: "acme/GitHub.com:", lower: "acme/github.com:" },
  { raw: "o/r/GitHub.com:", lower: "o/r/github.com:" },
  { raw: "acme/API.GitHub.com:", lower: "acme/api.github.com:" },
];

describe("a truncated-colon tail with a case-variant non-leading host word resolves like its lowercase sibling", () => {
  test("every resolver answers no owner and no repo, never a colon-carrying tail", () => {
    for (const { raw, lower } of CASE_COLON_TAILS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: lower })).toBe("");
      expect(orgOf(lower)).toBe("");
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: lower })]).toEqual([]);
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("");
      expect(orgOf(raw)).toBe("");
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw })]).toEqual([]);
      expect(resolveConfigDirName({ GITHUB_REPO: raw })).toBe(
        resolveConfigDirName({ GITHUB_REPO: lower })
      );
    }
  });

  test("the lowercase corpus keeps its pinned answers (regression guard)", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: "acme/github.com:" })).toBe("");
    expect(orgOf("o/r/github.com:")).toBe("");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "github.com:" })).toBe("");
    expect(orgOf("git@github.com:")).toBe("");
  });
});
