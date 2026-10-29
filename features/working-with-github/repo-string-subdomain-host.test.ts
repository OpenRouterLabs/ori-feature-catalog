import { describe, expect, test } from "bun:test";
// A github.com SUBDOMAIN host — `www.github.com`, `gist.github.com`,
// `codeload.github.com` (all real hosts: `https://www.github.com/o/r` and every
// gist URL redirect to github.com; codeload serves the very tarballs the
// ambient-mode recipe downloads) — is the same URL as `github.com`: every real
// git/gh/curl client accepts the subdomain spelling, and pasting one back into
// GITHUB_REPO is a realistic copy-paste. Pre-fix the subdomain prefix defeated
// every anchored `github.com` branch in all four repo-string resolvers (the
// generic github.com strips key on the host word at a `^` anchor, so
// `www.`/`gist.`/`codeload.` fell them all), while each resolver's own
// case-pairing answered a *different* dead value:
//   - lowercase subdomains survived by accident (an unanchored `github.com…$`
//     tail rule caught them), so `https://gist.github.com/acme/widgets`
//     answered `acme/widgets` — but the case-variant `Gist.GitHub.com/…` fell
//     every branch and answered the fake pair `Gist.GitHub.com/acme`;
//   - `orgOf("Gist.GitHub.com/acme/widgets")` answered the host word whole —
//     a registry key no mint can ever derive, silently bypassing a registered
//     App;
//   - `resolveAllowedOrgs` keyed the allowlist on `gist.github.com` — a login
//     no installation owner can ever carry, so every mint failed closed;
//   - `https://codeload.github.com/o/r/tarball/main` — a tarball route paste,
//     the exact URL the prompt's own download recipe builds — answered as if
//     it were a repo (`o/r`), naming a repo the path never was;
//   - the prompt's REPO= recipe had the same gap plus one of its own: its later
//     generic `github.com[/:]` strip consumed `github.com/` INSIDE the
//     subdomain host and welded the prefix onto the path
//     (`https://www.github.com/acme/widgets` → `https://www.acme/widgets`).
// One spelling contract, four resolvers plus the recipe (#285): strip the
// subdomain label so the existing github.com branches see the plain host.
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs, isAllowlistedOrg } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

const SUBDOMAIN_REPO = "https://www.github.com/acme/widgets";
const SUBDOMAIN_GIST = "https://gist.github.com/acme/widgets";
const SUBDOMAIN_GIST_CASE = "Gist.GitHub.com/acme/widgets";
const SUBDOMAIN_SCP = "git@www.github.com:acme/widgets";
const SUBDOMAIN_BARE_COLON = "www.github.com:acme/widgets";
const SUBDOMAIN_CODELOAD = "https://codeload.github.com/o/r/tarball/main";
const SUBDOMAIN_PORTED = "https://www.github.com:22/acme/widgets";
const SUBDOMAIN_SCHEME_CASE = "HTTPS://gist.github.com/acme/widgets";
const SUBDOMAIN_GIT = "https://www.github.com/acme/widgets.git";

describe("a github.com subdomain host resolves like the plain host in all four resolvers", () => {
  test("resolveRepoFromEnv answers the owner/repo, never a welded prefix or fake pair", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: SUBDOMAIN_REPO })).toBe(
      "acme/widgets"
    );
    expect(resolveRepoFromEnv({ GITHUB_REPO: SUBDOMAIN_GIST })).toBe(
      "acme/widgets"
    );
    expect(resolveRepoFromEnv({ GITHUB_REPO: SUBDOMAIN_GIST_CASE })).toBe(
      "acme/widgets"
    );
    expect(resolveRepoFromEnv({ GITHUB_REPO: SUBDOMAIN_SCP })).toBe(
      "acme/widgets"
    );
    expect(resolveRepoFromEnv({ GITHUB_REPO: SUBDOMAIN_BARE_COLON })).toBe(
      "acme/widgets"
    );
    expect(resolveRepoFromEnv({ GITHUB_REPO: SUBDOMAIN_PORTED })).toBe(
      "acme/widgets"
    );
    expect(resolveRepoFromEnv({ GITHUB_REPO: SUBDOMAIN_SCHEME_CASE })).toBe(
      "acme/widgets"
    );
    expect(resolveRepoFromEnv({ GITHUB_REPO: SUBDOMAIN_GIT })).toBe(
      "acme/widgets"
    );
  });

  test("a codeload tarball-route paste names its owner/repo pair like every other spelling", () => {
    // A deep paste on any spelling collapses to the owner/repo tail; the
    // subdomain host is not special. The pair it names is the real repo the
    // tarball belongs to.
    expect(resolveRepoFromEnv({ GITHUB_REPO: SUBDOMAIN_CODELOAD })).toBe("o/r");
  });

  test("orgOf answers the org, never the host word", () => {
    expect(orgOf(SUBDOMAIN_REPO)).toBe("acme");
    expect(orgOf(SUBDOMAIN_GIST)).toBe("acme");
    expect(orgOf(SUBDOMAIN_GIST_CASE)).toBe("acme");
    expect(orgOf(SUBDOMAIN_SCP)).toBe("acme");
    expect(orgOf(SUBDOMAIN_BARE_COLON)).toBe("acme");
    expect(orgOf(SUBDOMAIN_PORTED)).toBe("acme");
    expect(orgOf(SUBDOMAIN_SCHEME_CASE)).toBe("acme");
    expect(orgOf(SUBDOMAIN_CODELOAD)).toBe("o");
  });

  test("resolveAllowedOrgs allowlists the org, so mints do not fail closed", () => {
    for (const spelling of [
      SUBDOMAIN_REPO,
      SUBDOMAIN_GIST,
      SUBDOMAIN_GIST_CASE,
      SUBDOMAIN_SCP,
      SUBDOMAIN_PORTED,
      SUBDOMAIN_SCHEME_CASE,
    ]) {
      const allowed = resolveAllowedOrgs(undefined, {
        GITHUB_REPO: spelling,
      });
      expect(isAllowlistedOrg("acme", allowed)).toBe(true);
      expect(isAllowlistedOrg("gist.github.com", allowed)).toBe(false);
      expect(isAllowlistedOrg("www.github.com", allowed)).toBe(false);
    }
  });

  test("resolveConfigDirName keys on the repo segment, never a sanitized URL", () => {
    expect(resolveConfigDirName({ GITHUB_REPO: SUBDOMAIN_REPO })).toBe(
      "widgets"
    );
    expect(resolveConfigDirName({ GITHUB_REPO: SUBDOMAIN_GIST })).toBe(
      "widgets"
    );
    expect(resolveConfigDirName({ GITHUB_REPO: SUBDOMAIN_GIST_CASE })).toBe(
      "widgets"
    );
    expect(resolveConfigDirName({ GITHUB_REPO: SUBDOMAIN_SCP })).toBe(
      "widgets"
    );
    expect(resolveConfigDirName({ GITHUB_REPO: SUBDOMAIN_BARE_COLON })).toBe(
      "widgets"
    );
    expect(resolveConfigDirName({ GITHUB_REPO: SUBDOMAIN_PORTED })).toBe(
      "widgets"
    );
    expect(resolveConfigDirName({ GITHUB_REPO: SUBDOMAIN_SCHEME_CASE })).toBe(
      "widgets"
    );
    // An org page on a subdomain host keeps the org-page answer: the dir is
    // keyed on the ORG the resolvers agree on, never the raw host-cased URL.
    expect(resolveConfigDirName({ GITHUB_REPO: "https://gist.github.com/acme" })).toBe(
      "acme"
    );
  });

  test("a bare subdomain host names no owner/repo, like the plain bare host", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: "https://www.github.com" })).toBe("");
    expect(orgOf("https://www.github.com")).toBe("");
    expect(resolveConfigDirName({ GITHUB_REPO: "https://www.github.com" })).toBe(
      "intern"
    );
    expect(
      [...resolveAllowedOrgs(undefined, { GITHUB_REPO: "https://www.github.com" })]
    ).toEqual([]);
  });

  test("the api host keeps its own strip (a subdomain label never eats it)", () => {
    // api.github.com has its own dedicated normalization (it drops the host
    // AND the repos/ path word); the subdomain strip must not claim it.
    expect(resolveRepoFromEnv({ GITHUB_REPO: "https://api.github.com/repos/acme/widgets" })).toBe(
      "acme/widgets"
    );
    expect(orgOf("https://api.github.com/repos/acme/widgets")).toBe("acme");
  });
});
