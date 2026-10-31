import { describe, expect, test } from "bun:test";
// A github.com host word in the MIDDLE of a hostless path —
// `acme/github.com/widgets`, `x/github.com/y/z`, `owner/repo/github.com/tail`,
// `acme/api.github.com/widgets` (the URL path of a copied address pasted with
// extra junk in front of it, or a typo'd host) — is the spelling class #314
// filed. Pre-fix the FOUR code resolvers answered four DIFFERENT dead values
// from the one spelling, and the prompt's REPO= recipe a fifth:
//
//   "acme/github.com/widgets"      orgOf="widgets" repo="widgets" allow={widgets}
//   "x/github.com/y/z"             orgOf="y"      repo="y/z"      allow={y}
//   "owner/re/github.com/tail"     orgOf="tail"   repo="tail"     allow={tail}
//   "acme/api.github.com/widgets" orgOf="widgets" repo="widgets" allow={widgets}
//
// — while `resolveConfigDirName` keyed the config dir on `widgets`/`y`/`repo`/
// `api.widgets` (its unanchored `github.com[/:]` host strip eats the FIRST
// occurrence, so `x/github.com/y/z` keyed the DB on the `y` segment and
// `acme/api.github.com/widgets` on the sanitized `api.widgets` prefix), and
// the recipe stripped the first occurrence and welded the prefix onto the
// path (`acme/widgets`, `x/y`, `owner/repo`, `acme/api.widgets`).
//
// The code resolvers (`orgOf`, `resolveRepoFromEnv`, `resolveAllowedOrgs`)
// already agree among themselves here: their `github.com`-keyed branches are
// UNANCHORED at the start and `$`-anchored at the end, so a regex engine
// matches the LAST `github.com[/:]` occurrence — the reading that treats a
// mid-string host word as a genuine host and everything before it as junk.
// The one-spelling contract the corpus pins (README: "every resolver in this
// feature tolerates the other spellings too") says the config-dir resolver
// and the REPO= recipe must agree with that reading, so this test pins the
// LAST-host-word convention on every surface, including the resolvers that
// already hold it (a regression guard against ever "fixing" them the other
// way).
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

const MIDSTRING_HOSTLESS = "acme/github.com/widgets";
const MIDSTRING_DEEP = "x/github.com/y/z";
const MIDSTRING_THREE = "owner/repo/github.com/tail";
const MIDSTRING_API = "acme/api.github.com/widgets";

describe("a mid-string github.com host word resolves on one spelling contract in every resolver", () => {
  test("resolveRepoFromEnv answers the tail past the LAST host word, never a welded prefix", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: MIDSTRING_HOSTLESS })).toBe(
      "widgets"
    );
    expect(resolveRepoFromEnv({ GITHUB_REPO: MIDSTRING_DEEP })).toBe("y/z");
    expect(resolveRepoFromEnv({ GITHUB_REPO: MIDSTRING_THREE })).toBe("tail");
    expect(resolveRepoFromEnv({ GITHUB_REPO: MIDSTRING_API })).toBe("widgets");
  });

  test("orgOf answers the owner the same reading derives, never a dead prefix", () => {
    expect(orgOf(MIDSTRING_HOSTLESS)).toBe("widgets");
    expect(orgOf(MIDSTRING_DEEP)).toBe("y");
    expect(orgOf(MIDSTRING_THREE)).toBe("tail");
    expect(orgOf(MIDSTRING_API)).toBe("widgets");
  });

  test("resolveAllowedOrgs keys the allowlist on the same owner", () => {
    expect(
      Array.from(resolveAllowedOrgs(undefined, { GITHUB_REPO: MIDSTRING_HOSTLESS }))
    ).toEqual(["widgets"]);
    expect(
      Array.from(resolveAllowedOrgs(undefined, { GITHUB_REPO: MIDSTRING_DEEP }))
    ).toEqual(["y"]);
    expect(
      Array.from(resolveAllowedOrgs(undefined, { GITHUB_REPO: MIDSTRING_THREE }))
    ).toEqual(["tail"]);
    expect(
      Array.from(resolveAllowedOrgs(undefined, { GITHUB_REPO: MIDSTRING_API }))
    ).toEqual(["widgets"]);
  });

  test("resolveConfigDirName keys the same dir every other spelling of the repo keys", () => {
    // The config dir is the REPO SEGMENT of the pair the repo resolver
    // answers: `widgets` for the org-page reading, `z` for `y/z` — never the
    // sanitized prefix the pre-fix unanchored FIRST-occurrence strip welded.
    expect(resolveConfigDirName({ GITHUB_REPO: MIDSTRING_HOSTLESS })).toBe(
      "widgets"
    );
    expect(resolveConfigDirName({ GITHUB_REPO: MIDSTRING_DEEP })).toBe("z");
    expect(resolveConfigDirName({ GITHUB_REPO: MIDSTRING_THREE })).toBe(
      "tail"
    );
    expect(resolveConfigDirName({ GITHUB_REPO: MIDSTRING_API })).toBe(
      "widgets"
    );
  });

  test("every previously-healthy spelling keeps its pinned answer (corpus guard)", () => {
    // The mid-string reading must not leak into the single-occurrence
    // spellings the corpus already pins.
    for (const [spelling, repo, cfg] of [
      ["acme/widgets", "acme/widgets", "widgets"],
      ["https://github.com/acme/widgets", "acme/widgets", "widgets"],
      ["github.com/acme/widgets", "acme/widgets", "widgets"],
      ["git@github.com:acme/widgets", "acme/widgets", "widgets"],
      ["https://github.com/o/r/tree/main", "o/r", "r"],
      ["https://github.com/orgs/acme", "acme", "acme"],
      ["https://github.com/orgs", "", "intern"],
      ["https://github.com", "", "intern"],
      ["github.com:22", "", "intern"],
    ] as const) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe(repo);
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe(cfg);
    }
  });
});