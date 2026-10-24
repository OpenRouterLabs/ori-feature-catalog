import { describe, expect, test } from "bun:test";
// Regression: the scp/ssh host-word spellings of an ORG page —
// `git@github.com:acme` and `github.com:acme` (a colon, and no slash) —
// broke three of the four sibling resolvers at once while `orgOf` handled
// them:
//
//   - `resolveAllowedOrgs` kept the RAW string as the allowlist entry
//     (`git@github.com:acme`), a login no installation owner can ever
//     carry, so EVERY mint failed closed with "Refusing to mint a token …
//     not in the allowed-orgs allowlist (git@github.com:acme)" — with no
//     hint the env var's spelling was the cause;
//   - `resolveConfigDirName` sanitized the raw string into
//     `git-github.com-acme` / `github.com-acme`, silently migrating the
//     registry/cache DB to a different directory than every other spelling
//     of the same repo resolves to, orphaning the rows already written.
//
// The resolvers share one spelling contract (README: "every resolver in this
// feature tolerates the other spellings too"), and the org-URL branch each
// of them grew for `https://github.com/acme` (slash-host spellings) was
// never extended to the colon forms. This suite pins the colon corpus
// across every resolver the same way repo-string-deepurl.test.ts pins the
// deep-URL corpus.

import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";

const COLON_HOST_ORGS: readonly string[] = [
  "git@github.com:acme",
  "github.com:acme",
];

describe("colon-host org spellings resolve like their org form", () => {
  test("orgOf keeps extracting the owner (the contract every sibling shares)", () => {
    for (const raw of COLON_HOST_ORGS) {
      expect(orgOf(raw)).toBe("acme");
    }
  });

  test("resolveAllowedOrgs allows the owner, never the raw host-word string", () => {
    for (const raw of COLON_HOST_ORGS) {
      const allowed = resolveAllowedOrgs(undefined, {
        GITHUB_REPO: raw,
      });
      expect([...allowed]).toEqual(["acme"]);
    }
  });

  test("resolveConfigDirName keys on the org, never a sanitized raw string", () => {
    for (const raw of COLON_HOST_ORGS) {
      expect(
        resolveConfigDirName({ GITHUB_REPO: raw, INTERN_NAME: "" })
      ).toBe("acme");
    }
  });

  test("resolveRepoFromEnv keeps collapsing the spelling to its org segment", () => {
    for (const raw of COLON_HOST_ORGS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("acme");
    }
  });

  test("a bare colon-less owner keeps its direct pass-through in every resolver", () => {
    expect(orgOf("acme")).toBe("acme");
    expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: "acme" })]).toEqual(
      ["acme"]
    );
    expect(resolveConfigDirName({ GITHUB_REPO: "acme", INTERN_NAME: "" })).toBe(
      "acme"
    );
    expect(resolveRepoFromEnv({ GITHUB_REPO: "acme" })).toBe("acme");
  });

  test("a colon-host REPO spelling keeps resolving to owner/repo in every resolver", () => {
    for (const raw of [
      "git@github.com:acme/widgets",
      "github.com:acme/widgets",
    ]) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("acme/widgets");
      expect(orgOf(raw)).toBe("acme");
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw })]).toEqual(
        ["acme"]
      );
      expect(
        resolveConfigDirName({ GITHUB_REPO: raw, INTERN_NAME: "" })
      ).toBe("widgets");
    }
  });
});
