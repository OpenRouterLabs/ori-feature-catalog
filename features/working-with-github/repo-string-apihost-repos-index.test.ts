import { describe, expect, test } from "bun:test";
// An api.github.com paste of the REST COLLECTION INDEX —
// `api.github.com/repos` (also `https://api.github.com/repos`, the trailing-
// slash, ported, case-variant, user-info, and leading-slash forms of the
// same URL) — is the root of the very REST namespace this feature's own
// prompt teaches the operator to curl (`GET /repos/{owner}/{repo}`, the
// raw-file and tarball recipes all build `api.github.com/repos/…` URLs), so
// pasting the collection root back into GITHUB_REPO is a realistic spelling.
// It is also the exact sibling of the organizations-page INDEX spelling
// `api.github.com/orgs` (#237/#288's class), with one difference: the api
// strip strips the host and then the CANONICAL `repos/` PATH WORD only when
// a path follows it, so the BARE index tail survives as `repos` — and the
// index guard below it names only `(orgs|organizations|users)`. Pre-fix all
// five surfaces keyed the reserved REST path word itself:
//
//   - `resolveRepoFromEnv` → "repos" (a fake owner/repo pair; `repos/repos`
//     404s, verified live — `repos` is a host-path word, never a login);
//   - `orgOf` → "repos" (a registry key no mint can ever derive, silently
//     bypassing a registered App);
//   - `resolveAllowedOrgs` → {"repos"} (a login no installation owner can
//     ever carry, so EVERY mint failed closed with no hint the env var's
//     spelling was the cause);
//   - `resolveConfigDirName` → "repos" (a NEW config dir — the registry/cache
//     DB silently migrates, orphaning every row the healthy spellings wrote);
//   - the prompt's `REPO=` sed recipe → "repos" (the same fake pair in every
//     interpolated `$REPO`).
//
// One spelling, five surfaces, one contract. The orgs index answered ""
// for the same shape; the repos index must too — a repo named `repos` under
// a real owner is unreachable by this spelling (it needs the owner segment
// the index lacks).
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

/** Every api-paste spelling of the REST collection index. */
const INDEX_SPELLINGS: readonly string[] = [
  "api.github.com/repos",
  "https://api.github.com/repos",
  // A trailing slash is the same page (the tail strips remove it before the
  // guard; pinned so the guard's optional-trailing-slash tolerance is
  // honest).
  "api.github.com/repos/",
  // The ported, case-variant, user-info, and leading-slash forms of the
  // same URL — the spellings the sibling api strips already tolerate.
  "api.github.com:443/repos",
  "API.GitHub.com/repos",
  "ssh://git@api.github.com/repos",
  "https://deploy@api.github.com/repos",
  "//api.github.com/repos",
];

describe("an api.github.com repos-index paste resolves to no owner/repo", () => {
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

  test("the repo-bearing spellings still resolve to their owner/repo", () => {
    expect(
      resolveRepoFromEnv({
        GITHUB_REPO: "https://api.github.com/repos/acme/widgets",
      })
    ).toBe("acme/widgets");
    expect(orgOf("api.github.com/repos/acme/widgets")).toBe("acme");
    expect(
      Array.from(
        resolveAllowedOrgs(undefined, {
          GITHUB_REPO: "https://api.github.com/repos/acme/widgets",
        })
      )
    ).toEqual(["acme"]);
  });

  test("the orgs index spellings are unchanged", () => {
    expect(orgOf("api.github.com/orgs")).toBe("");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "api.github.com/users" })).toBe(
      ""
    );
  });
});
