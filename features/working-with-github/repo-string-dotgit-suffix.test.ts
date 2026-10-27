import { describe, expect, test } from "bun:test";
// Regression: a `.git` SUFFIX that carries a QUERY or FRAGMENT rider
// (`https://github.com/acme/widgets.git?tab=readme`,
// `…widgets.git#frag` — a browser address-bar copy-paste of the repo page,
// the tab/anchor the browser was on riding past the clone suffix) is a
// spelling class every OTHER strip in these resolvers already handles
// (repo-string-queryfrag.test.ts, repo-string-slashdotgit.test.ts), and
// pre-fix each resolver answered a DIFFERENT dead value for it:
//
//   orgOf("…/acme/widgets.git?tab=readme")               → "acme"          (healthy)
//   resolveAllowedOrgs                                    → {"acme"}         (healthy)
//   resolveConfigDirName                                  → "widgets"        (healthy)
//   resolveRepoFromEnv("…/acme/widgets.git?tab=readme")   → "acme/widgets"  (healthy)
//   the prompt's REPO= sed recipe                          → "acme/widgets.git"  (dead — 404)
//
// The recipe stripped the `.git` suffix BEFORE the query/fragment rider, so
// `…widgets.git?tab=readme` matched neither its `.git` rule (anchored `$`,
// the rider sat past it) nor the later suffix strips, and `$REPO` carried
// the clone suffix into every interpolation: `gh --repo acme/widgets.git`
// (no such repo), `repos/acme/widgets.git` — verified live: 404 — and a
// worktree SLUG (`acme-widgets.git`) no sweep lists. The CODE resolvers
// strip the rider first; this suite pins that side, prompt-recipes.test.ts
// pins the recipe.
//
// The TRAILING-SLASH half (`…widgets.git/?tab=readme`) exposed a second
// divergence inside `resolveRepoFromEnv` itself: its `.git` rule anchored
// `$` missed the rider-bearing tail, the trailing-slash strip ran after
// it, and the resolver answered `acme/widgets.git` — a value every
// `repos/{repo}` route 404s on (`repos/o/r.git/`, verified live) while
// `orgOf` and the recipe answered the healthy pair. The slash-strip ↔
// `.git`-strip order the slash-dot-git fix established runs BOTH ways.
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

/** A `.git` suffix with a query/fragment rider — one spelling, four answers. */
const DOTGIT_RIDER_SPELLINGS: readonly string[] = [
  "https://github.com/acme/widgets.git?tab=readme",
  "https://github.com/acme/widgets.git#frag",
  "git@github.com:acme/widgets.git?x=1",
  "git@github.com:acme/widgets.git#frag",
  "acme/widgets.git?x=1",
  "ssh://git@github.com:22/acme/widgets.git?x=1",
  // A TRAILING SLASH between the `.git` suffix and the rider (an address-bar
  // paste whose tab rode past the slash) exposes the suffix only AFTER the
  // rider strip: pre-fix the first `.git` rule (anchored `$`) missed, the
  // trailing-slash strip ran on the rider-bearing tail, and the resolver
  // answered `acme/widgets.git` — a route every `repos/{repo}` 404s on
  // (`repos/o/r.git/`, verified live) while `orgOf` and the recipe answered
  // the healthy pair. Re-strip the suffix after the separator strip.
  "https://github.com/acme/widgets.git/?tab=readme",
  "https://github.com/acme/widgets.git/#frag",
];

describe("a .git suffix carrying a query/fragment rider resolves healthy in every resolver", () => {
  test("resolveRepoFromEnv answers the bare pair", () => {
    for (const raw of DOTGIT_RIDER_SPELLINGS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("acme/widgets");
    }
  });
  test("orgOf answers the owner", () => {
    for (const raw of DOTGIT_RIDER_SPELLINGS) {
      expect(orgOf(raw)).toBe("acme");
    }
  });
  test("the allowlist keys on the owner", () => {
    for (const raw of DOTGIT_RIDER_SPELLINGS) {
      expect(
        Array.from(resolveAllowedOrgs(undefined, { GITHUB_REPO: raw }))
      ).toEqual(["acme"]);
    }
  });
  test("the config dir keys on the repo name", () => {
    for (const raw of DOTGIT_RIDER_SPELLINGS) {
      expect(resolveConfigDirName({ GITHUB_REPO: raw })).toBe("widgets");
    }
  });
});