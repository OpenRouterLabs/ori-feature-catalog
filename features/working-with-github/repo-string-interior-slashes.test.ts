import { describe, expect, test } from "bun:test";
// Regression: an interior doubled slash in a GitHub URL spelling of
// GITHUB_REPO — `https://github.com//o/r`, `github.com//o/r`, `o//r`, or a
// doubled segment separator like `https://github.com/o//r` (a copy-paste
// that kept a doubled path slash, the same paste class as the trailing
// slash, which every resolver already strips) — broke all four sibling
// resolvers at once:
//
//   - `resolveRepoFromEnv` returned the RAW string (its regexes key on the
//     two-segment tail `[^/]+/[^/]+`, which an empty path segment never
//     matches), so every `repos/{repo}` API route 404'd;
//   - `orgOf` returned the raw string too, so a registry row or allowlist
//     entry derived from it could never match the org a mint derives;
//   - `resolveAllowedOrgs` carried the raw URL as the allowlist entry, a
//     login no installation can ever own, so every mint failed closed;
//   - `resolveConfigDirName` keyed the registry/cache DB on a SANITIZED URL
//     (`https-github.com-o-r`) — a directory no other spelling resolves to,
//     silently migrating the DB and orphaning its rows.
//
// The four resolvers share one spelling contract (README: "every resolver
// in this feature tolerates the other spellings too"), and the prompt's
// REPO= sed recipe collapses the same paste (its `s#[/[:space:]]+$##`
// handles the tail; the interior empty segment survives it too, but every
// NON-empty segment the code resolvers see is what the routes take), so
// collapsing empty path segments up front keeps all four on one path.

import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";

const INTERIOR_DOUBLE_SLASH: readonly string[] = [
  "https://github.com//o/r",
  "https://github.com///o/r",
  "github.com//o/r",
  "git@github.com://o/r",
  "https://github.com/o//r",
];

const BARE_INTERIOR: readonly string[] = [
  "o//r",
  "o///r",
];

describe("interior doubled slashes resolve like their single-slash form", () => {
  test("resolveRepoFromEnv collapses the empty path segment", () => {
    for (const raw of INTERIOR_DOUBLE_SLASH) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("o/r");
    }
    for (const raw of BARE_INTERIOR) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("o/r");
    }
  });

  test("orgOf extracts the owner past the empty segment", () => {
    for (const raw of INTERIOR_DOUBLE_SLASH) {
      expect(orgOf(raw)).toBe("o");
    }
    for (const raw of BARE_INTERIOR) {
      expect(orgOf(raw)).toBe("o");
    }
  });

  test("resolveAllowedOrgs allows the owner, not the raw URL", () => {
    for (const raw of [...INTERIOR_DOUBLE_SLASH, ...BARE_INTERIOR]) {
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw })]).toEqual(
        ["o"]
      );
    }
  });

  test("resolveConfigDirName keys on the repo name, not a sanitized URL", () => {
    for (const raw of [...INTERIOR_DOUBLE_SLASH, ...BARE_INTERIOR]) {
      expect(resolveConfigDirName({ GITHUB_REPO: raw })).toBe("r");
    }
  });
});
