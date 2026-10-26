import { describe, expect, test } from "bun:test";
// An upper-case SCHEME on a bare-host spelling — `HTTPS://github.com`,
// `HTTP://github.com`, `FTP://github.com`, `SSH://github.com` (a copy-paste
// whose scheme kept the address bar's capitalization; also a mixed-case host
// under it, `HTTPS://GitHub.com`) — is the same URL as its lowercase form:
// schemes are case-insensitive (RFC 3986 §3.1), and hosts are too
// (§3.2.2), so every real git/gh/curl client accepts the spelling. Pre-fix
// the interior-slash collapse's lookbehind guard lists the scheme words
// case-SENSITIVELY (`https?`, `ssh`, `git+ssh`, `ftp`) while the host-lower
// regex before it lower-cases ONLY the host word, never the scheme — so an
// upper-case scheme's `://` collapsed to `:` (`HTTPS:github.com`) and every
// downstream bare-host branch missed:
//
//   - `orgOf` and `resolveRepoFromEnv` returned the raw junk
//     (`HTTPS:github.com`) — a repo no `repos/{repo}` route answers, a worktree
//     SLUG keyed on it;
//   - `resolveAllowedOrgs` keyed the allowlist on `https:github.com` — a login
//     no installation owner can ever carry, so EVERY mint failed closed with
//     no hint the env var's spelling was the cause;
//   - `resolveConfigDirName` keyed the registry/cache DB dir on
//     `https-github.com` — silently migrating the DB the moment the env var's
//     spelling changed case (#113's class).
//
// The prompt's `REPO=` recipe already empties these bare-host spellings
// (prompt-recipes.test.ts pins it), so the recipe and all four code resolvers
// silently disagreed — the same one-spelling contract the host-case fix
// (#159/#169's class, repo-string-hostcase.test.ts) closed for the mixed-case
// HOST, reopened through the scheme word. The resolvers now lower-case the
// SCHEME word exactly like the host word, so the guard spares its `://` and
// the existing bare-host branches answer `""` (orgOf/resolveRepoFromEnv),
// `[]` (allowlist), and `"intern"` (config dir) — byte-for-byte the lowercase
// spelling's answer.
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import {
  isAllowlistedOrg,
  resolveAllowedOrgs,
} from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

const UPPER_SCHEME_BARE_HOSTS: readonly string[] = [
  "HTTPS://github.com",
  "HTTP://github.com",
  "FTP://github.com",
  "SSH://github.com",
  "HTTPS://GitHub.com",
  "HTTPS://GITHUB.COM",
];

describe("an upper-case scheme on a bare host resolves like the lowercase spelling in all four resolvers", () => {
  test("orgOf answers no owner, never the collapsed scheme junk", () => {
    for (const spelling of UPPER_SCHEME_BARE_HOSTS) {
      expect(orgOf(spelling)).toBe("");
      expect(orgOf(spelling)).not.toContain(":");
    }
  });

  test("resolveRepoFromEnv answers no owner/repo, never the raw host string", () => {
    for (const spelling of UPPER_SCHEME_BARE_HOSTS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe("");
    }
  });

  test("resolveAllowedOrgs allows no one, so mints fail closed honestly", () => {
    for (const spelling of UPPER_SCHEME_BARE_HOSTS) {
      const allowed = resolveAllowedOrgs(undefined, {
        GITHUB_REPO: spelling,
      });
      expect(Array.from(allowed)).toEqual([]);
      expect(isAllowlistedOrg("acme", allowed)).toBe(false);
      expect(isAllowlistedOrg("github.com", allowed)).toBe(false);
      expect(isAllowlistedOrg("https:github.com", allowed)).toBe(false);
    }
  });

  test("resolveConfigDirName keeps the documented no-repo fallback dir", () => {
    for (const spelling of UPPER_SCHEME_BARE_HOSTS) {
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe("intern");
    }
  });

  test("a port on an upper-case-scheme bare host answers like its portless form", () => {
    expect(orgOf("HTTPS://github.com:443")).toBe("");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "HTTPS://github.com:443" })).toBe(
      ""
    );
    expect(
      resolveConfigDirName({ GITHUB_REPO: "HTTPS://github.com:443" })
    ).toBe("intern");
  });

  test("an upper-case scheme with an owner keeps resolving the owner", () => {
    expect(orgOf("HTTPS://github.com/acme/widgets")).toBe("acme");
    expect(
      resolveRepoFromEnv({ GITHUB_REPO: "HTTPS://github.com/acme/widgets" })
    ).toBe("acme/widgets");
    expect(
      resolveConfigDirName({ GITHUB_REPO: "HTTPS://github.com/acme/widgets" })
    ).toBe("widgets");
    const allowed = resolveAllowedOrgs(undefined, {
      GITHUB_REPO: "HTTPS://github.com/acme/widgets",
    });
    expect(isAllowlistedOrg("acme", allowed)).toBe(true);
  });
});
