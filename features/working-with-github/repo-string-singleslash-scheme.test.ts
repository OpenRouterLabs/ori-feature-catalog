import { describe, expect, test } from "bun:test";
// A scheme whose separator lost a slash — `https:/github.com/acme/widgets`,
// `https:github.com/acme/widgets` (a URL pasted from a terminal or an
// address bar that collapsed its own `//`; curl normalizes the form and
// answers 200, so it is a real client-accepted spelling of the same URL) —
// is the same URL as its `://` sibling, and the resolvers' one-spelling
// contract demands the same answer. Pre-fix every `://`-ANCHORED branch
// missed the single-slash/colon separator (the scheme groups spell `://`),
// so the bare-host and index forms leaked the scheme into every resolver:
//
//   - `orgOf` answered `https:` — a registry key no mint's lookup can ever
//     produce, silently re-routing every mint to the default App;
//   - `resolveAllowedOrgs` admitted `https:` as an ALLOWLIST LOGIN — a
//     login no installation owner can ever carry, so every mint failed
//     closed with no hint the env var's spelling was the cause;
//   - `resolveRepoFromEnv` returned the raw string (`https:/github.com`) —
//     a repo every `repos/{repo}` route 404s on;
//   - `resolveConfigDirName` keyed `github.com` / `https-github.com` —
//     silently migrating the registry/cache DB (#113's class).
//
// The owner-bearing forms were already rescued by the suffix-keyed deep/tail
// branches (they carry no scheme anchor), which is exactly the silent
// disagreement this closes: one spelling, resolvers answering different
// values. A host-case single-slash owner form (`HTTPS:/GitHub.com/acme/x`)
// answered the raw host string while its slash-bearing sibling answered the
// healthy pair — the #159/#169 case class reopened through the separator.
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import {
  isAllowlistedOrg,
  resolveAllowedOrgs,
} from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

const SINGLE_SLASH_OWNER_BEARING: readonly string[] = [
  "https:/github.com/acme/widgets",
  "https:github.com/acme/widgets",
  "http:/github.com/acme/widgets",
  "https:/github.com/acme/widgets.git",
  "https:/github.com:443/acme/widgets",
  "HTTPS:/GitHub.com/acme/widgets",
  "SSH:/git@github.com/acme/widgets",
  "git+ssh:/github.com/acme/widgets",
  "ftp:/github.com/acme/widgets",
  " https:/github.com/acme/widgets ",
  "https:/github.com/acme/widgets?tab=readme",
  "https:/api.github.com/repos/acme/widgets",
  "https:/raw.githubusercontent.com/acme/widgets/main/f.ts",
  "https:/www.github.com/acme/widgets",
  "https:/gist.github.com/acme/widgets",
  "https:/codeload.github.com/acme/widgets/tarball/main",
];

const SINGLE_SLASH_BARE_HOST: readonly string[] = [
  "https:/github.com",
  "https:github.com",
  "http:/github.com",
  "http:github.com",
  "https:/raw.githubusercontent.com",
  "ftp:/github.com",
  "SSH:/github.com",
];

const SINGLE_SLASH_INDEX: readonly string[] = [
  "https:/github.com/orgs",
  "https:/github.com/organizations",
];

describe("a single-slash scheme spelling resolves like its :// form in all four resolvers", () => {
  test("owner-bearing forms answer the healthy owner/repo", () => {
    for (const spelling of SINGLE_SLASH_OWNER_BEARING) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe(
        "acme/widgets"
      );
      expect(orgOf(spelling)).toBe("acme");
      const allowed = resolveAllowedOrgs(undefined, {
        GITHUB_REPO: spelling,
      });
      expect(isAllowlistedOrg("acme", allowed)).toBe(true);
      expect(Array.from(allowed)).toEqual(["acme"]);
    }
  });

  test("api/users forms answer the user login", () => {
    expect(
      resolveRepoFromEnv({ GITHUB_REPO: "https:/api.github.com/users/octocat" })
    ).toBe("octocat");
    expect(orgOf("https:/api.github.com/users/octocat")).toBe("octocat");
  });

  test("bare-host forms answer no owner, never the leaked scheme", () => {
    for (const spelling of SINGLE_SLASH_BARE_HOST) {
      expect(orgOf(spelling)).toBe("");
      expect(orgOf(spelling)).not.toContain(":");
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe("");
      const allowed = resolveAllowedOrgs(undefined, {
        GITHUB_REPO: spelling,
      });
      expect(Array.from(allowed)).toEqual([]);
      expect(isAllowlistedOrg("acme", allowed)).toBe(false);
      expect(isAllowlistedOrg("https:", allowed)).toBe(false);
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe("intern");
    }
  });

  test("index forms answer no owner/repo, never a partial junk tail", () => {
    for (const spelling of SINGLE_SLASH_INDEX) {
      expect(orgOf(spelling)).toBe("");
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe("");
      expect(
        Array.from(resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling }))
      ).toEqual([]);
    }
  });

  test("the org-URL form answers the org it names", () => {
    expect(orgOf("https:/github.com/acme")).toBe("acme");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "https:/github.com/acme" })).toBe(
      "acme"
    );
    expect(
      resolveConfigDirName({ GITHUB_REPO: "https:/github.com/acme" })
    ).toBe("acme");
  });

  test("an scp spec and a bare colon pair are untouched (no scheme word, no host)", () => {
    // The rule must not rewrite the scp separator or an owner:repo colon pair:
    // neither carries a scheme word before its colon.
    expect(orgOf("git@github.com:acme/widgets")).toBe("acme");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "git@github.com:acme/widgets" })).toBe(
      "acme/widgets"
    );
    expect(resolveRepoFromEnv({ GITHUB_REPO: "acme:widgets" })).toBe(
      "acme:widgets"
    );
    expect(resolveRepoFromEnv({ GITHUB_REPO: "github.com:22/acme/widgets" })).toBe(
      "acme/widgets"
    );
  });
});
