import { describe, expect, test } from "bun:test";
// Regression: the single-slash scheme + BARE github.com SUBDOMAIN host —
// `https:/www.github.com`, `http:/gist.github.com` (a URL whose `//`
// collapsed AND whose host carries the one-label prefix, with no owner and
// no repo segment after it) — is the same URL as its `://` sibling, whose
// answer every resolver already gives ("no owner / no repo / intern").
// Pre-fix all four resolvers answered the RAW URL from the one spelling,
// because the #295 scheme-separator rewrite runs AFTER the #286 subdomain
// strip in every chain: the strip's scheme group spells `://`, so the
// single-slash form missed it, the label survived, and the separator fix
// then repaired `https:/` → `https://` WITHOUT re-running the strip — the
// string left the chain as `https://www.github.com`, which no anchored
// `github.com` branch below ever matches (they all key on the host word at
// a `^` anchor behind an OPTIONAL `://`, and `www.` sits in front of it):
//
//   - `orgOf` → "https://www.github.com" — a registry key no mint can ever
//     derive from a real repo string, silently re-routing every mint to the
//     default App;
//   - `resolveRepoFromEnv` → "https://www.github.com" — a repo every
//     `repos/{repo}` route 404s on and `gh --repo` rejects;
//   - `resolveConfigDirName` → "https-www.github.com" — silently migrating
//     the registry/cache DB (#113's class);
//   - the REPO= sed recipe → "" (its own rules strip the prefix after its
//     scheme-separator fix), so the prompt and the code disagreed on one
//     spelling.
//
// The owner-bearing single-slash subdomain forms (`https:/www.github.com/acme/widgets`)
// are already healthy (#295's suite pins them — the deep/tail branches rescue
// them without a scheme anchor) and the bare PLAIN host
// (`https:/github.com`) is already healthy (no label to strip), which is
// exactly why this hole hid: it needs all three at once — a lost slash, a
// subdomain label, and no path.
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

const SINGLE_SLASH_BARE_SUBDOMAIN: readonly string[] = [
  "https:/www.github.com",
  "https:/gist.github.com",
  "https:/codeload.github.com",
  "https:/education.github.com",
  "http:/www.github.com",
  "http:/gist.github.com",
  "HTTPS:/WWW.github.com",
  " https:/www.github.com ",
  "https:/www.github.com/",
  "https:/www.github.com.git",
  "https:/www.github.com#frag",
  "https:/gist.github.com?tab=readme",
];

describe("a single-slash scheme on a bare subdomain host resolves like its :// form", () => {
  test("orgOf answers no owner, never the raw URL", () => {
    for (const spelling of SINGLE_SLASH_BARE_SUBDOMAIN) {
      expect(orgOf(spelling)).toBe("");
    }
  });

  test("resolveRepoFromEnv agrees — the empty string for every spelling", () => {
    for (const spelling of SINGLE_SLASH_BARE_SUBDOMAIN) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe("");
    }
  });

  test("resolveAllowedOrgs is empty, so every mint fails closed honestly", () => {
    for (const spelling of SINGLE_SLASH_BARE_SUBDOMAIN) {
      expect([
        ...resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling }),
      ]).toEqual([]);
    }
  });

  test("resolveConfigDirName falls back to intern, never a sanitized URL", () => {
    for (const spelling of SINGLE_SLASH_BARE_SUBDOMAIN) {
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe("intern");
    }
  });
});

describe("the neighboring spellings keep their existing behavior", () => {
  test("the :// sibling of every damaged spelling was already healthy", () => {
    expect(orgOf("https://www.github.com")).toBe("");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "https://www.github.com" })).toBe(
      ""
    );
    expect(
      Array.from(
        resolveAllowedOrgs(undefined, { GITHUB_REPO: "https://www.github.com" })
      )
    ).toEqual([]);
    expect(resolveConfigDirName({ GITHUB_REPO: "https://www.github.com" })).toBe(
      "intern"
    );
  });

  test("the owner-bearing single-slash subdomain forms stay healthy (#295's pins)", () => {
    expect(orgOf("https:/www.github.com/acme/widgets")).toBe("acme");
    expect(
      resolveRepoFromEnv({ GITHUB_REPO: "https:/www.github.com/acme/widgets" })
    ).toBe("acme/widgets");
    expect(
      Array.from(
        resolveAllowedOrgs(undefined, {
          GITHUB_REPO: "https:/www.github.com/acme/widgets",
        })
      )
    ).toEqual(["acme"]);
  });

  test("the bare PLAIN host with a single-slash scheme stays healthy", () => {
    expect(orgOf("https:/github.com")).toBe("");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "https:/github.com" })).toBe("");
    expect(resolveConfigDirName({ GITHUB_REPO: "https:/github.com" })).toBe(
      "intern"
    );
  });
});
