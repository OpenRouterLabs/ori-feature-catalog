import { describe, expect, test } from "bun:test";
// Regression: a deep GitHub URL spelling of GITHUB_REPO —
// `https://github.com/acme/widgets/tree/main`, a copied blob/tree/PR/releases
// address — broke all four sibling resolvers at once:
//
//   - `resolveRepoFromEnv` returned the RAW URL, so every
//     `repos/{repo}` API route 404'd (the class the two-segment URL fix
//     closed, reopened through the deep path);
//   - `orgOf` returned the raw URL, so a registry row registered from a deep
//     `--repo`/`--org` spelling could never match the org a mint derives —
//     every mint silently fell back to the default App (#101 class);
//   - `resolveAllowedOrgs` reduced the URL to its SCHEME (`https:`), a login
//     no installation can ever carry, so every mint failed closed with no
//     hint why;
//   - `resolveConfigDirName` resolved the config-dir name from the URL's
//     LAST segment (`main`, `x.ts`, even `42`), silently migrating the
//     registry/cache DB to a new directory and orphaning the old rows.
//
// The four resolvers share one spelling contract (README: "every resolver in
// this feature tolerates the other spellings too"), so this suite pins all
// four against the same deep-URL corpus.

import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";

const DEEP_URLS: readonly string[] = [
  "https://github.com/acme/widgets/tree/main",
  "https://github.com/acme/widgets/blob/main/src/x.ts",
  "https://github.com/acme/widgets/pull/42",
  "https://github.com/acme/widgets/releases",
  "https://github.com/acme/widgets/tree/main/", // trailing slash too
];

const FLAT_REPOS: readonly string[] = [
  "acme/widgets",
  "https://github.com/acme/widgets",
  "https://github.com/acme/widgets.git",
  "git@github.com:acme/widgets.git",
  "acme/widgets/",
];

describe("deep GitHub URL spellings resolve like their owner/repo form", () => {
  test("resolveRepoFromEnv collapses every deep URL to owner/repo", () => {
    for (const raw of DEEP_URLS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("acme/widgets");
    }
  });

  test("orgOf extracts the owner from every deep URL", () => {
    for (const raw of DEEP_URLS) {
      expect(orgOf(raw)).toBe("acme");
    }
  });

  test("resolveAllowedOrgs allows the owner, not the scheme, for a deep URL", () => {
    for (const raw of DEEP_URLS) {
      const allowed = resolveAllowedOrgs(undefined, {
        GITHUB_REPO: raw,
      });
      expect([...allowed]).toEqual(["acme"]);
    }
  });

  test("resolveConfigDirName keys on the repo name, not the URL's last segment", () => {
    for (const raw of DEEP_URLS) {
      expect(resolveConfigDirName({ GITHUB_REPO: raw })).toBe("widgets");
    }
  });

  test("the flat spellings keep their established resolutions", () => {
    for (const raw of FLAT_REPOS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("acme/widgets");
      expect(orgOf(raw)).toBe("acme");
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw })]).toEqual(
        ["acme"]
      );
      expect(resolveConfigDirName({ GITHUB_REPO: raw })).toBe("widgets");
    }
  });

  test("an org URL and a bare org keep their established resolutions", () => {
    // `https://github.com/orgs/acme` is the documented --org spelling; it is
    // NOT a repo string, and must keep resolving as before the deep-path fix.
    expect(orgOf("https://github.com/orgs/acme")).toBe("orgs");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "acme" })).toBe("acme");
    expect(orgOf("acme")).toBe("acme");
  });
});
