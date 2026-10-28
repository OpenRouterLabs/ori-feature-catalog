import { describe, expect, test } from "bun:test";
// Regression: WHITESPACE AHEAD OF A RIDER — `o/r ?tab=readme`, `o/r #anchor`,
// `o/r /` (a browser address-bar copy-paste whose line kept a space between
// the repo and its tab/anchor, the same paste class the #249 separator-
// adjacent-whitespace corpus pins for the INTERIOR of a path) — is a
// GITHUB_REPO spelling whose QUERY/FRAGMENT rider and trailing separator sit
// past a space the trims in every resolver strip only from the string's
// raw tail. Pre-fix `resolveRepoFromEnv` answered `"o/r "` for all of them:
// the rider strips (`s#[?][^/]*$##` in the prompt's REPO= recipe, the
// `/\?.*$/`/`/#.*$/` pair in the code resolvers) keyed on the raw tail, so a
// rider past a space was not the string's tail yet, and once it came off
// the exposed `"o/r "` kept its space — while every sibling resolver
// (`orgOf`, `resolveAllowedOrgs`, `resolveConfigDirName`) and the prompt's
// REPO= sed recipe (its `s#[/[:space:]]+$##` trim runs BEFORE its rider
// strips, and `[^/]*` matches the space just as well as it matches the
// rider) answered the healthy `o/r`. One spelling, five disagreeing
// answers — the exact one-spelling contract the README states
// ("every resolver in this feature tolerates the other spellings too")
// — and the surviving tail breaks every consumer downstream: `repos/o/r `
// (404), `gh --repo "o/r "`, the `github.com/${REPO}.git` fetch URL (git
// appends `/info/refs` past the space), and a worktree SLUG keyed on
// `o-r-`. The fix is the strip ORDER the recipe already has: trim the tail
// BEFORE stripping the rider, so the rider IS the string's tail when the
// strip keys on it.
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

/** A rider or trailing separator past an interior space. */
const RIDER_PAST_SPACE: readonly string[] = [
  "o/r ?tab=readme",
  "o/r #anchor",
  "o/r /",
  "o/r /.git/",
  "https://github.com/o/r ?x=1",
  "https://github.com/o/r #frag",
  "https://github.com/o/r /",
];

/** The same rider with no space still resolves (corpus guard). */
const RIDER_PLAIN: readonly string[] = [
  "o/r?tab=readme",
  "o/r#anchor",
  "o/r/",
  "https://github.com/o/r?x=1",
];

describe("a rider past an interior space resolves like the rider alone", () => {
  test("resolveRepoFromEnv trims the exposed tail after the rider strip", () => {
    for (const raw of RIDER_PAST_SPACE) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("o/r");
    }
    for (const raw of RIDER_PLAIN) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("o/r");
    }
  });

  test("orgOf answers the owner past the space", () => {
    for (const raw of RIDER_PAST_SPACE) {
      expect(orgOf(raw)).toBe("o");
    }
  });

  test("the allowlist keys on the owner", () => {
    for (const raw of RIDER_PAST_SPACE) {
      expect([
        ...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw }),
      ]).toEqual(["o"]);
    }
  });

  test("the config dir keys on the repo name", () => {
    for (const raw of RIDER_PAST_SPACE) {
      expect(
        resolveConfigDirName({ GITHUB_REPO: raw, INTERN_NAME: "" })
      ).toBe("r");
    }
  });
});