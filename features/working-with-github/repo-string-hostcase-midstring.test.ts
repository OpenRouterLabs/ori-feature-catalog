import { describe, expect, test } from "bun:test";
// A HOST-CASE spelling in a NON-LEADING position — a case-variant
// `GitHub.com` host word in the middle of a hostless path
// (`acme/GitHub.com/widgets`), as the SECOND host of a paste
// (`git@github.com:GitHub.com/orgs/acme`), or as the path tail of an
// api/raw host (`API.GitHub.com/GitHub.com/o/r`) — is the same URL as its
// lowercase sibling (hosts are case-insensitive, RFC 3986 §3.2.2, the exact
// contract repo-string-hostcase.test.ts pins for the LEADING host word).
// The case-lower at the head of each resolver only normalizes the FIRST,
// `^`-anchored host word, and every branch that reads a host word in a
// non-leading position — the unanchored two-segment/deep/org-URL matches,
// the orgs-page extractors, the config-dir greedy LAST-host strip — keys on
// a case-SENSITIVE `github.com` literal, so the case-variant word fell them
// and each resolver answered a different dead value than its own lowercase
// sibling: pre-fix, one spelling, four surfaces, the lowercase sibling
// answering a different reading —
//
//   "acme/GitHub.com/widgets"               repo="acme/GitHub.com" (a fake
//     owner/repo pair every repos/{repo} route 404s on) while the sibling
//     answered "widgets";
//   "git@github.com:GitHub.com/orgs/acme"    repo="GitHub.com/orgs",
//     org="GitHub.com" (a registry key no installation can carry — every
//     mint silently bypasses the registered App) while the sibling answered
//     "acme";
//   "API.GitHub.com/GitHub.com/o/r"          org="GitHub.com" while
//     resolveAllowedOrgs keyed the allowlist on "o" — the registry key and
//     the allowlist disagreeing on one spelling.
//
// Fix: give every non-leading host-word reader the same case-paired
// character class the anchored strips already use, so one spelling keeps
// one reading across all four resolvers and the REPO= recipe.
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

/** The mid-string family: a case-variant host word inside a hostless path. */
const MIDSTRING_CASE: readonly { readonly raw: string; readonly lower: string; readonly repo: string; readonly org: string; readonly cfg: string }[] = [
  { raw: "acme/GitHub.com/widgets", lower: "acme/github.com/widgets", repo: "widgets", org: "widgets", cfg: "widgets" },
  { raw: "x/GitHub.com/y/z", lower: "x/github.com/y/z", repo: "y/z", org: "y", cfg: "z" },
  { raw: "acme/GitHub.com/o/r/tree/main", lower: "acme/github.com/o/r/tree/main", repo: "o/r", org: "o", cfg: "r" },
];

/** The second-host family: a case-variant host word past a first, lowercase host. */
const SECOND_HOST_CASE: readonly { readonly raw: string; readonly lower: string }[] = [
  { raw: "git@github.com:GitHub.com/orgs/acme", lower: "git@github.com:github.com/orgs/acme" },
  { raw: "github.com:GitHub.com/orgs/acme", lower: "github.com:github.com/orgs/acme" },
  { raw: "github.com/GitHub.com/orgs/acme", lower: "github.com/github.com/orgs/acme" },
  { raw: "git@GitHub.com:GitHub.com/users/bob", lower: "git@github.com:github.com/users/bob" },
  { raw: "github.com:GitHub.com/orgs", lower: "github.com:github.com/orgs" },
];

/** The api/raw-tail family: a case-variant host word in a content host's path. */
const API_RAW_TAIL_CASE: readonly { readonly raw: string; readonly lower: string }[] = [
  { raw: "API.GitHub.com/GitHub.com/o/r", lower: "api.github.com/github.com/o/r" },
  { raw: "https://API.GitHub.com/GitHub.com/o/r", lower: "https://api.github.com/github.com/o/r" },
  { raw: "https://RAW.githubusercontent.com/GitHub.com/o/r", lower: "https://raw.githubusercontent.com/github.com/o/r" },
  { raw: "https://raw.githubusercontent.com/acme/GitHub.com/o/r", lower: "https://raw.githubusercontent.com/acme/github.com/o/r" },
];

describe("a case-variant host word in a non-leading position resolves like its lowercase sibling", () => {
  test("the mid-string family: every resolver answers the sibling's reading", () => {
    for (const { raw, lower, repo, org, cfg } of MIDSTRING_CASE) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe(repo);
      expect(orgOf(raw)).toBe(org);
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw })]).toEqual([org]);
      expect(resolveConfigDirName({ GITHUB_REPO: raw })).toBe(cfg);
      // The lowercase sibling keeps its byte-identical answer (corpus guard).
      expect(resolveRepoFromEnv({ GITHUB_REPO: lower })).toBe(repo);
      expect(orgOf(lower)).toBe(org);
    }
  });

  test("the second-host family: the orgs-page reading wins, never the host word", () => {
    for (const { raw, lower } of SECOND_HOST_CASE) {
      const expectedRepo = resolveRepoFromEnv({ GITHUB_REPO: lower });
      const expectedOrg = orgOf(lower);
      expect(expectedOrg).not.toBe("github.com");
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe(expectedRepo);
      expect(orgOf(raw)).toBe(expectedOrg);
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw })]).toEqual(
        [...resolveAllowedOrgs(undefined, { GITHUB_REPO: lower })]
      );
    }
  });

  test("the api/raw-tail family: the owner the lowercase sibling derives, never the host word", () => {
    for (const { raw, lower } of API_RAW_TAIL_CASE) {
      const expectedOrg = orgOf(lower);
      expect(expectedOrg).toBe("o");
      expect(orgOf(raw)).toBe(expectedOrg);
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw })]).toEqual(
        [...resolveAllowedOrgs(undefined, { GITHUB_REPO: lower })]
      );
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe(
        resolveRepoFromEnv({ GITHUB_REPO: lower })
      );
    }
  });

  test("the pinned org-named-host corpus keeps its answers (regression guard)", () => {
    // An org literally named `GitHub.com` keeps its case in the ORG segment —
    // the case-tolerant host readers must not eat it (prompt-recipes-orgs-host-org
    // pins this shape; this test guards the code side of the same contract).
    expect(orgOf("https://GitHub.com/orgs/GitHub.com")).toBe("GitHub.com");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "https://GitHub.com/orgs/GitHub.com" })).toBe("GitHub.com");
    expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: "https://GitHub.com/orgs/GitHub.com" })]).toEqual(["github.com"]);
    expect(resolveConfigDirName({ GITHUB_REPO: "https://GitHub.com/orgs/GitHub.com" })).toBe("github.com");
    // The mid-string pinned corpus stays byte-identical.
    expect(resolveRepoFromEnv({ GITHUB_REPO: "github.com/x/github.com/y/z" })).toBe("x/github.com");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "github.com/github.com/o/r" })).toBe("github.com/o");
    expect(orgOf("acme/github.com/widgets")).toBe("widgets");
  });
});
