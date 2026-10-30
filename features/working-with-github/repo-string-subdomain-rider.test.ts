import { describe, expect, test } from "bun:test";
// A QUERY, FRAGMENT, `.git` suffix, or whitespace riding PAST a BARE
// github.com SUBDOMAIN host — `www.github.com#frag`, `gist.github.com?tab=x`,
// `https://codeload.github.com.git`, ` www.github.com ` (a browser
// address-bar copy-paste or a `git remote -v` paste cut at the host, the
// #285 subdomain class reopened through the rider/suffix/padding position) —
// is the same URL as its rider-less form, which every resolver already
// answers with the honest no-owner `""`. Pre-fix the subdomain strip ran
// FIRST, on the raw string, with a `$`-or-separator-anchored lookahead: the
// rider sat past the host word, the lookahead failed, the label survived,
// and each resolver answered a *different* dead value from the same spelling
// while the prompt's REPO= recipe answered `""` — the one-spelling contract
// the whole corpus closes, broken through the rider position. The plain-host
// twin of the same spelling (`github.com#frag`) was already healthy because
// the case-lower that handles it runs AFTER the trim/rider strips; the
// subdomain strip is the one site that ran before them.
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs, isAllowlistedOrg } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

const RIDER_SUBDOMAINS: readonly {
  readonly expected: string;
  readonly raw: string;
}[] = [
  { expected: "", raw: "www.github.com#frag" },
  { expected: "", raw: "www.github.com?tab=readme" },
  { expected: "", raw: "gist.github.com#frag" },
  { expected: "", raw: "gist.github.com?tab=readme" },
  { expected: "", raw: "codeload.github.com#anchor?x" },
  { expected: "", raw: "www.github.com.git" },
  { expected: "", raw: "https://www.github.com.git" },
  { expected: "", raw: "gist.github.com.git" },
  { expected: "", raw: "https://gist.github.com#frag" },
  { expected: "", raw: "https://www.github.com?tab=readme" },
  { expected: "", raw: "git@www.github.com#frag" },
  { expected: "", raw: "git@gist.github.com.git" },
  { expected: "", raw: "ssh://git@www.github.com#frag" },
  { expected: "", raw: "www.github.com " },
  { expected: "", raw: " www.github.com" },
  { expected: "", raw: " https://gist.github.com " },
  { expected: "", raw: "https://git@www.github.com?tab=readme" },
  { expected: "", raw: "WWW.GitHub.COM.git" },
];

describe("a rider past a bare github.com subdomain host resolves like its rider-less form in all four resolvers", () => {
  test("resolveRepoFromEnv answers the honest no-owner value, never the raw host", () => {
    for (const { expected, raw } of RIDER_SUBDOMAINS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe(expected);
    }
  });

  test("orgOf answers no org, never the host word a mint could key on", () => {
    for (const { expected, raw } of RIDER_SUBDOMAINS) {
      expect(orgOf(raw)).toBe(expected);
    }
  });

  test("resolveAllowedOrgs derives no allowlist entry, so a mint fails closed honestly", () => {
    for (const { raw } of RIDER_SUBDOMAINS) {
      const allowed = resolveAllowedOrgs(undefined, { GITHUB_REPO: raw });
      expect(allowed.size).toBe(0);
      // The dead-value shape the class produced pre-fix: the host word (or a
      // sanitized URL) carried as a login no installation owner can match.
      expect(isAllowlistedOrg("www.github.com", allowed)).toBe(false);
      expect(isAllowlistedOrg("gist.github.com", allowed)).toBe(false);
    }
  });

  test("resolveConfigDirName falls back to the documented no-repo dir, never a sanitized URL", () => {
    for (const { raw } of RIDER_SUBDOMAINS) {
      expect(resolveConfigDirName({ GITHUB_REPO: raw })).toBe("intern");
    }
  });

  test("the rider-less twin forms keep their pinned healthy answers (corpus guard)", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: "www.github.com" })).toBe("");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "https://gist.github.com" })).toBe("");
    expect(orgOf("www.github.com")).toBe("");
    expect(orgOf("codeload.github.com")).toBe("");
    expect(Array.from(resolveAllowedOrgs(undefined, { GITHUB_REPO: "www.github.com" })).length).toBe(0);
    expect(resolveConfigDirName({ GITHUB_REPO: "www.github.com" })).toBe("intern");
  });

  test("a subdomain host WITH a path keeps its pinned healthy answers (the #285 corpus)", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: "https://www.github.com/acme/widgets" })).toBe("acme/widgets");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "https://gist.github.com/acme/widgets?tab=readme" })).toBe("acme/widgets");
    expect(orgOf("www.github.com/acme/widgets")).toBe("acme");
    expect(orgOf("https://codeload.github.com/o/r/tarball/main")).toBe("o");
    expect(Array.from(resolveAllowedOrgs(undefined, { GITHUB_REPO: "https://gist.github.com/acme/widgets" }))).toEqual(["acme"]);
  });

  test("a rider past the bare PLAIN host keeps its pinned healthy answers (the #159 corpus)", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: "github.com#frag" })).toBe("");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "github.com.git" })).toBe("");
    expect(orgOf("GitHub.com#frag")).toBe("");
    expect(orgOf("https://github.com?tab=readme")).toBe("");
  });

  test("the api host keeps its dedicated handling (excluded label, own strip)", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: "api.github.com#frag" })).toBe("");
    expect(orgOf("api.github.com?tab=readme")).toBe("");
    expect(
      resolveRepoFromEnv({
        GITHUB_REPO: "https://api.github.com/repos/acme/widgets",
      })
    ).toBe("acme/widgets");
  });
});
