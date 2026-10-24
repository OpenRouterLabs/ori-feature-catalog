import { describe, expect, test } from "bun:test";

import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

/**
 * The `/.git` (separator-then-dot-git) suffix spelling —
 * `https://github.com/acme/.git`, `github.com:acme/.git`, `acme/.git`, …
 * (a paste whose `.git` lands after a path separator) — left an INTERIOR trailing
 * slash behind in every repo-string resolver: the strip order was
 * trailing-slashes-then-`.git`, so `.git` came off last and exposed a `/` no later
 * branch re-stripped. Every `$`-anchored regex then missed (the org-URL and
 * two-segment branches both require the segment to END the string), and the raw
 * URL flowed through as the "org"/"repo"/config-dir key:
 *
 *   - `orgOf("https://github.com/acme/.git")` returned the whole URL — a registry
 *     row registered for the real org never matched, silently falling back to
 *     the default App.
 *   - `resolveRepoFromEnv` returned the whole URL — every `repos/{repo}` route
 *     404s (the gh-auth-health round-trip fails, commits/PR lookups fail).
 *   - `resolveConfigDirName` returned a sanitized URL (`https-github-com-acme`)
 *     — the registry/cache DB silently MIGRATED to a different directory,
 *     orphaning every row the other spelling wrote.
 *
 * `resolveAllowedOrgs` survived only by accident (its fallback routes through
 * `orgOf`, which normalized the SAME spelling differently than its own regexes).
 * The prompt's `REPO=` sed recipe already collapses every one of these spellings
 * (`s#\.git$##` then `s#/$##`), so the recipe and the code disagreed.
 */
const SLASH_DOT_GIT_SPELLINGS: readonly {
  readonly expectedDir: string;
  readonly expectedOrg: string;
  readonly expectedRepo: string;
  readonly raw: string;
}[] = [
  {
    expectedDir: "acme",
    expectedOrg: "acme",
    expectedRepo: "acme",
    raw: "https://github.com/acme/.git",
  },
  {
    expectedDir: "acme",
    expectedOrg: "acme",
    expectedRepo: "acme",
    raw: "http://github.com/acme/.git",
  },
  {
    expectedDir: "acme",
    expectedOrg: "acme",
    expectedRepo: "acme",
    raw: "git@github.com:acme/.git",
  },
  {
    expectedDir: "acme",
    expectedOrg: "acme",
    expectedRepo: "acme",
    raw: "github.com:acme/.git",
  },
  {
    expectedDir: "acme",
    expectedOrg: "acme",
    expectedRepo: "acme",
    raw: "ssh://git@github.com:22/acme/.git",
  },
  {
    expectedDir: "acme",
    expectedOrg: "acme",
    expectedRepo: "acme",
    raw: "github.com:29418/acme/.git",
  },
  {
    expectedDir: "acme",
    expectedOrg: "acme",
    expectedRepo: "acme",
    raw: "acme/.git",
  },
  // The BARE orgs-page spelling ("orgs/acme/.git") is intentionally absent:
  // it keeps its existing two-segment reading (owner `orgs`) — the orgs-page
  // branch only fires on a github.com host, and the bare form is genuinely
  // ambiguous with an owner literally named `orgs`. The fix must not change
  // that reading; it only has to stop the HOST-ful spellings from returning
  // the raw string with the interior slash attached.
  {
    expectedDir: "acme",
    expectedOrg: "acme",
    expectedRepo: "acme",
    raw: "https://github.com/orgs/acme/.git",
  },
];

describe("the /.git (separator-then-dot-git) suffix resolves like every other spelling", () => {
  for (const { expectedDir, expectedOrg, expectedRepo, raw } of SLASH_DOT_GIT_SPELLINGS) {
    test(`orgOf(${JSON.stringify(raw)}) resolves to the org`, () => {
      expect(orgOf(raw)).toBe(expectedOrg);
    });

    test(`resolveRepoFromEnv(${JSON.stringify(raw)}) resolves to the owner, never a raw URL`, () => {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe(expectedRepo);
    });

    test(`resolveAllowedOrgs(${JSON.stringify(raw)}) resolves to the org`, () => {
      expect([
        ...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw }),
      ]).toEqual([expectedOrg]);
    });

    test(`resolveConfigDirName(${JSON.stringify(raw)}) keys the same directory as the org spelling`, () => {
      expect(resolveConfigDirName({ GITHUB_REPO: raw })).toBe(expectedDir);
    });
  }

  test("a repo segment still resolves normally when the spelling carries /.git after it", () => {
    // The two-segment forms keep their existing behavior — the fix must not
    // regress them.
    expect(orgOf("https://github.com/acme/widgets/.git")).toBe("acme");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "https://github.com/acme/widgets/.git" })).toBe(
      "acme/widgets"
    );
    expect(resolveConfigDirName({ GITHUB_REPO: "https://github.com/acme/widgets/.git" })).toBe(
      "widgets"
    );
    expect([
      ...resolveAllowedOrgs(undefined, {
        GITHUB_REPO: "https://github.com/acme/widgets/.git",
      }),
    ]).toEqual(["acme"]);
  });
});
