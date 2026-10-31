// Regression: a HOSTLESS mid-string spelling whose tail past the `github.com`
// segment is a BARE COLON — `acme/github.com:`, `o/r/github.com:`,
// `acme/api.github.com:` (a `git remote -v` paste cut at the scp host colon,
// pasted onto a bare path with no scheme, no user-info and no host word) —
// names no owner and no repo: the tail is the truncated-host class the
// recipe, `orgOf`, `resolveAllowedOrgs` and `resolveConfigDirName` already
// answer the honest no-owner value for.
//
// Pre-fix `resolveRepoFromEnv` returned the RAW spelling whole as the "repo":
// its own truncated-colon guard sits BELOW the hostless two-segment/deep
// branches, and a bare path ending at the host word matched
// `^([^/]+\/[^/]+)(?:\/.*)?$` first — `acme` / `github.com:` captured across
// the two segments, the `:` riding inside the second `[^/]+` — so the bare
// pass-through flowed the junk on and every `repos/{repo}` route 404'd
// (`repos/acme/github.com:` is not a route) while `gh --repo` rejects it —
// the exact one-spelling class the #322/#325 recipe edits closed for the
// RESERVED-word tails, reopened through the truncated-colon tail. Measured
// on current main, one spelling, every surface:
//
//   acme/github.com:   orgOf ""   allow {}   cfg "intern"   recipe ""
//                     resolveRepoFromEnv "acme/github.com:"  ← the raw junk
//
// The one-spelling contract (README: "every resolver in this feature
// tolerates the other spellings too") demands `resolveRepoFromEnv` answer the
// same no-owner value its siblings answer — `""`, so the callers that must
// fail loudly do (commit-via-api's `--repo (or set GITHUB_REPO)` diagnostic,
// the schedules' die, the CLI's exit-1 line).

import { describe, expect, test } from "bun:test";

import { isRepoUnset, resolveRepoFromEnv } from "./scripts/commit-api-core.ts";
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";

const COLON_TAILS: readonly string[] = [
  "acme/github.com:",
  "o/r/github.com:",
  "x/github.com:",
  "acme/api.github.com:",
];

describe("a hostless truncated-colon tail past a mid-string host", () => {
  test("orgOf answers no owner for the whole class", () => {
    for (const raw of COLON_TAILS) {
      expect(orgOf(raw)).toBe("");
    }
  });

  test("resolveAllowedOrgs allows no one for the whole class", () => {
    for (const raw of COLON_TAILS) {
      expect(
        Array.from(resolveAllowedOrgs(undefined, { GITHUB_REPO: raw }))
      ).toEqual([]);
    }
  });

  test("resolveConfigDirName takes its documented intern fallback", () => {
    for (const raw of COLON_TAILS) {
      expect(resolveConfigDirName({ GITHUB_REPO: raw })).toBe("intern");
    }
  });

  test("resolveRepoFromEnv answers no repo, never the raw junk", () => {
    for (const raw of COLON_TAILS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("");
      // SET, not unset: the diagnosis channel is the spelling, never
      // "GITHUB_REPO is not set" (the #207 never-blame-a-healthy-env rule).
      expect(isRepoUnset({ GITHUB_REPO: raw })).toBe(false);
    }
  });

  test("the healthy neighbors keep their existing answers", () => {
    // A path segment past the colon is the `git@…:o/r`-shaped tail on a
    // bare path — the deep reading, untouched by the fix.
    expect(resolveRepoFromEnv({ GITHUB_REPO: "acme/github.com:o" })).toBe("o");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "x/github.com:y/z" })).toBe("y/z");
    // A plain path with no host word at all keeps its raw pass-through.
    expect(resolveRepoFromEnv({ GITHUB_REPO: "acme/widgets:" })).toBe(
      "acme/widgets:"
    );
    // A reserved-word tail past the host (#324/#325's class) keeps its
    // two-segment reading.
    expect(resolveRepoFromEnv({ GITHUB_REPO: "acme/widgets/github.com" })).toBe(
      "acme/widgets"
    );
  });
});