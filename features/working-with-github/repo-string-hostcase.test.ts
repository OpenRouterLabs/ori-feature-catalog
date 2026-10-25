import { describe, expect, test } from "bun:test";
// A HOST-CASE spelling — `https://GitHub.com/acme/widgets`,
// `git@GitHub.com:acme/widgets`, `GitHub.com:22/acme` (a copy-paste whose host
// kept the address bar's capitalization, or an ssh config alias) — is the same
// URL: hosts are case-insensitive (RFC 3986 §3.2.2), and every real git/gh/curl
// client accepts the mixed-case host. Pre-fix the mixed-case host fell every
// anchored `github.com` branch in all four repo-string resolvers (`orgOf`,
// `resolveRepoFromEnv`, `resolveAllowedOrgs`, `resolveConfigDirName`) and the
// raw URL was returned whole — a registry key no mint can ever derive, an
// allowlist entry no installation can ever own, a config dir keyed on junk
// URL segments, and a `repos/{repo}` route that 404s — the same silent-dead-value
// class the closed issues fixed for other spellings (#159 deep URL, #169/#175
// colon-host, #186 port), reopened through the host's capitalization. The
// owner/repo PATH keeps its case (GitHub logins are case-sensitive);
// only the host word is lower-cased.
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import {
  isAllowlistedOrg,
  resolveAllowedOrgs,
} from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

const HOST_CASE_REPO = "https://GitHub.com/acme/widgets";
const HOST_CASE_SCP = "git@GitHub.com:acme/widgets";
const HOST_CASE_PORT = "ssh://git@GitHub.com:22/acme/widgets";
const HOST_CASE_SCHEME = "HTTPS://GitHub.com/acme/widgets";

describe("a host-case spelling resolves like every other spelling in all four resolvers", () => {
  test("resolveRepoFromEnv keeps the owner/repo, never the raw URL", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: HOST_CASE_REPO })).toBe(
      "acme/widgets"
    );
    expect(resolveRepoFromEnv({ GITHUB_REPO: HOST_CASE_SCP })).toBe(
      "acme/widgets"
    );
    expect(resolveRepoFromEnv({ GITHUB_REPO: HOST_CASE_PORT })).toBe(
      "acme/widgets"
    );
  });
  test("orgOf resolves to the org, never the raw URL", () => {
    expect(orgOf(HOST_CASE_REPO)).toBe("acme");
    expect(orgOf(HOST_CASE_SCP)).toBe("acme");
    expect(orgOf(HOST_CASE_PORT)).toBe("acme");
  });

  test("an upper-case scheme is the same URL (RFC 3986 §3.1: scheme is case-insensitive)", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: HOST_CASE_SCHEME })).toBe(
      "acme/widgets"
    );
    expect(orgOf(HOST_CASE_SCHEME)).toBe("acme");
    expect(resolveConfigDirName({ GITHUB_REPO: HOST_CASE_SCHEME })).toBe(
      "widgets"
    );
  });
  test("resolveAllowedOrgs allowlists the org, so mints do not fail closed", () => {
    const allowed = resolveAllowedOrgs(undefined, {
      GITHUB_REPO: HOST_CASE_REPO,
    });
    expect(isAllowlistedOrg("acme", allowed)).toBe(true);
    expect(
      isAllowlistedOrg("https://github.com/acme/widgets", allowed)
    ).toBe(false);
  });
  test("resolveConfigDirName keys on the repo segment, never the raw URL", () => {
    expect(resolveConfigDirName({ GITHUB_REPO: HOST_CASE_REPO })).toBe(
      "widgets"
    );
    expect(resolveConfigDirName({ GITHUB_REPO: HOST_CASE_SCP })).toBe(
      "widgets"
    );
  });
  test("the owner/repo path keeps its case (logins are case-sensitive)", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: "acme/Widgets" })).toBe(
      "acme/Widgets"
    );
    expect(orgOf("acme/Widgets")).toBe("acme");
  });
  test("an orgs-page INDEX spelling with a host case still names no owner", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: "https://GitHub.com/orgs" })).toBe(
      ""
    );
    expect(orgOf("https://GitHub.com/orgs")).toBe("");
    expect(resolveConfigDirName({ GITHUB_REPO: "https://GitHub.com/orgs" })).toBe(
      "intern"
    );
  });
});