import { describe, expect, test } from "bun:test";
// Regression (the api.github.com paste class, reopened through a COLON host
// separator): the api-host strips in all four repo-string resolvers anchor on
// `…[Cc][Oo][Mm](?:\/|$)` — the path must start with a SLASH right after the
// host — so a REST-address copy-paste whose host word rides a COLON separator
// into the path (`API.GitHub.com:acme/widgets` — the scp/ssh host:tail shape a
// `git remote -v` copy-paste produces for any host, also the empty-port paste
// `https://api.github.com:/acme/widgets`, and the port+colon double
// `HTTPS://API.GitHub.com:22:acme/widgets`) is never recognized as the api
// host at all. Pre-fix every resolver then keyed on a different dead value:
//
//   - `resolveRepoFromEnv` → the whole string
//     (`"API.GitHub.com:acme/widgets"`) — every `repos/{repo}` route 404s and
//     `gh --repo` rejects it;
//   - `orgOf` → `"API.GitHub.com:acme"` — a registry key no mint can ever
//     derive, silently bypassing a registered App and falling back to the
//     default one;
//   - `resolveAllowedOrgs` → a lower-cased host string with its separator
//     (`"api.github.com:acme"`) — a login no installation owner can ever
//     carry, so EVERY mint failed closed with no hint the env var's spelling
//     was the cause;
//   - `resolveConfigDirName` → a fourth answer again (`"api.github.com-acme"`
//     for the bare spelling, `"https-api.github.com-acme"` for the schemed
//     one) — silently migrating the registry/cache DB.
//
// For the LOWERCASE colon form the repo/org/allowlist trio already answers
// healthy (the unanchored case-sensitive `github.com` branches match inside
// `api.github.com`), but `resolveConfigDirName` diverges for the schemed
// spellings — four resolvers, three agreeing answers and a fourth that keys
// a different directory — so the corpus pins the lowercase colon form too.
// The fix makes every api-host anchor accept the `[/:]` separator set the
// sibling `github.com` strips already tolerate. Every slash-separated
// spelling keeps its byte-identical answer.
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

/** api.github.com hosts riding a COLON separator into the path. */
const COLON_API_HOSTS: readonly {
  readonly expectedDir: string;
  readonly expectedOrg: string;
  readonly expectedRepo: string;
  readonly raw: string;
}[] = [
  {
    expectedDir: "widgets",
    expectedOrg: "acme",
    expectedRepo: "acme/widgets",
    raw: "API.GitHub.com:acme/widgets",
  },
  {
    expectedDir: "widgets",
    expectedOrg: "acme",
    expectedRepo: "acme/widgets",
    raw: "HTTPS://API.GitHub.com:/acme/widgets",
  },
  {
    expectedDir: "widgets",
    expectedOrg: "acme",
    expectedRepo: "acme/widgets",
    raw: "https://api.github.com:acme/widgets",
  },
  {
    expectedDir: "widgets",
    expectedOrg: "acme",
    expectedRepo: "acme/widgets",
    raw: "https://api.github.com:/acme/widgets",
  },
  {
    expectedDir: "widgets",
    expectedOrg: "acme",
    expectedRepo: "acme/widgets",
    raw: "HTTPS://API.GitHub.com:22:acme/widgets",
  },
  {
    expectedDir: "acme",
    expectedOrg: "acme",
    expectedRepo: "acme",
    raw: "API.GitHub.com:acme",
  },
  {
    expectedDir: "acme",
    expectedOrg: "acme",
    expectedRepo: "acme",
    raw: "https://api.github.com:acme",
  },
  {
    expectedDir: "widgets",
    expectedOrg: "acme",
    expectedRepo: "acme/widgets",
    raw: "git@api.github.com:acme/widgets",
  },
];

describe("an api.github.com host riding a colon separator resolves like its slash form", () => {
  test("resolveRepoFromEnv answers owner/repo, never the host word with its separator", () => {
    for (const { expectedRepo, raw } of COLON_API_HOSTS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe(expectedRepo);
    }
  });

  test("orgOf answers the owner, never the host string", () => {
    for (const { expectedOrg, raw } of COLON_API_HOSTS) {
      expect(orgOf(raw)).toBe(expectedOrg);
    }
  });

  test("resolveAllowedOrgs keys the allowlist on the owner, so mints do not fail closed", () => {
    for (const { expectedOrg, raw } of COLON_API_HOSTS) {
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw })]).toEqual(
        [expectedOrg]
      );
    }
  });

  test("resolveConfigDirName keys the same directory every other spelling keys", () => {
    for (const { expectedDir, raw } of COLON_API_HOSTS) {
      expect(resolveConfigDirName({ GITHUB_REPO: raw })).toBe(expectedDir);
    }
  });

  test("the slash-separated api forms stay byte-identical", () => {
    expect(
      resolveRepoFromEnv({
        GITHUB_REPO: "https://api.github.com/repos/acme/widgets",
      })
    ).toBe("acme/widgets");
    expect(
      resolveRepoFromEnv({
        GITHUB_REPO: "https://API.GitHub.com:443/repos/acme/widgets",
      })
    ).toBe("acme/widgets");
    expect(orgOf("https://api.github.com/repos/acme/widgets")).toBe("acme");
    expect(orgOf("https://API.GitHub.com:443/repos/acme/widgets")).toBe("acme");
    expect(resolveConfigDirName({ GITHUB_REPO: "api.github.com/repos/acme/widgets" })).toBe(
      "widgets"
    );
  });
});
