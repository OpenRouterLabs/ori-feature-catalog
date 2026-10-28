import { describe, expect, test } from "bun:test";
// Regression (the api.github.com paste class, reopened through the HOST
// WORD's case AND an explicit PORT at once): a REST-address copy-paste whose
// api host kept the address bar's capitalization AND carried a port —
// `https://API.GitHub.com:443/repos/acme/widgets`,
// `https://api.GitHub.com:443/users/acme`,
// `API.GitHub.com:443/repos/acme/widgets` — is the same URL as its
// lowercase unported form (hosts are case-insensitive, RFC 3986 §3.2.2; a
// port names no owner), and the sibling corpora already pin each dimension
// alone: repo-string-apihost-case-userinfo.test.ts pins the case-variant
// api host with NO port healthy, and the ported lowercase api host is
// healthy too (its `github.com` sub-word is lowercase, so the shared port
// strip `((?:git@)?github\.com):\d+` matches INSIDE `api.github.com`). The
// COMBINATION is the one cell left dead in all four resolvers at once: the
// case-variant host defeats the case-sensitive port strip, and the port
// defeats the api-host strip (its `…[Cc][Oo][Mm](?:\/|$)` anchor requires
// the path right after the host). Pre-fix, every resolver answered a
// different dead value:
//
//   - `resolveRepoFromEnv` → the whole URL / `API.GitHub.com:443/repos` —
//     every `repos/{repo}` route 404s;
//   - `orgOf` → `API.GitHub.com:443` — a registry key no mint can ever
//     derive, silently bypassing a registered App;
//   - `resolveAllowedOrgs` → {"https://api.github.com:443/repos/acme/widgets"}
//     (the case-lowered HOST, port and all) — a login no installation owner
//     can ever carry, so EVERY mint failed closed with no hint the env
//     var's spelling was the cause;
//   - `resolveConfigDirName` → "repos" / "users" / "orgs" (the REST path
//     word) — a fourth answer, silently migrating the registry/cache DB.
//
// Four disagreeing answers for one spelling — the README's one-spelling
// contract. The fix makes the shared port strip case-tolerant on the api
// host (the same `[Gg][Ii][Tt][Hh][Uu][Bb]` case-pairing the api-host strip
// already carries) so a ported case-variant api host strips like every
// sibling spelling. Every lowercase spelling keeps its byte-identical
// answer.
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

/** Case-variant api hosts carrying an explicit port. */
const CASE_PORTED_API_HOSTS: readonly {
  readonly expectedDir: string;
  readonly expectedOrg: string;
  readonly expectedRepo: string;
  readonly raw: string;
}[] = [
  {
    expectedDir: "widgets",
    expectedOrg: "acme",
    expectedRepo: "acme/widgets",
    raw: "https://API.GitHub.com:443/repos/acme/widgets",
  },
  {
    expectedDir: "widgets",
    expectedOrg: "acme",
    expectedRepo: "acme/widgets",
    raw: "API.GitHub.com:443/repos/acme/widgets",
  },
  {
    expectedDir: "acme",
    expectedOrg: "acme",
    expectedRepo: "acme",
    raw: "https://api.GitHub.com:443/users/acme",
  },
  {
    expectedDir: "acme",
    expectedOrg: "acme",
    expectedRepo: "acme",
    raw: "https://API.GitHub.com:443/orgs/acme",
  },
  {
    expectedDir: "acme",
    expectedOrg: "acme",
    expectedRepo: "acme",
    raw: "api.GITHUB.COM:443/orgs/acme",
  },
];

describe("a case-variant api host with a port resolves like its lowercase form", () => {
  test("resolveRepoFromEnv answers owner/repo, never the host word or the path word", () => {
    for (const { expectedRepo, raw } of CASE_PORTED_API_HOSTS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe(expectedRepo);
    }
  });

  test("orgOf answers the owner, never the host string with its port", () => {
    for (const { expectedOrg, raw } of CASE_PORTED_API_HOSTS) {
      expect(orgOf(raw)).toBe(expectedOrg);
    }
  });

  test("resolveAllowedOrgs keys the allowlist on the owner, so mints do not fail closed", () => {
    for (const { expectedOrg, raw } of CASE_PORTED_API_HOSTS) {
      expect([
        ...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw }),
      ]).toEqual([expectedOrg]);
    }
  });

  test("resolveConfigDirName keys the same directory every other spelling keys", () => {
    for (const { expectedDir, raw } of CASE_PORTED_API_HOSTS) {
      expect(resolveConfigDirName({ GITHUB_REPO: raw })).toBe(expectedDir);
    }
  });

  test("the lowercase ported and case-variant unported forms stay byte-identical", () => {
    expect(
      resolveRepoFromEnv({
        GITHUB_REPO: "https://api.github.com:443/repos/acme/widgets",
      })
    ).toBe("acme/widgets");
    expect(
      resolveRepoFromEnv({
        GITHUB_REPO: "https://API.GitHub.com/repos/acme/widgets",
      })
    ).toBe("acme/widgets");
    expect(orgOf("https://api.github.com:443/orgs/acme")).toBe("acme");
    expect(orgOf("https://Api.github.com/repos/acme/widgets")).toBe("acme");
  });
});
