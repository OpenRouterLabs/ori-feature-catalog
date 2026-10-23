import { describe, expect, test } from "bun:test";

import { orgOf } from "./gh-app-registry.ts";

describe("orgOf — repo-string spellings", () => {
  test("bare owner/repo", () => {
    expect(orgOf("acme-corp/widgets")).toBe("acme-corp");
  });

  test("bare owner/repo with .git suffix", () => {
    expect(orgOf("acme-corp/widgets.git")).toBe("acme-corp");
  });

  test("full https URL with .git", () => {
    expect(orgOf("https://github.com/acme-corp/widgets.git")).toBe("acme-corp");
  });

  test("full https URL without .git", () => {
    expect(orgOf("https://github.com/acme-corp/widgets")).toBe("acme-corp");
  });

  test("ssh/scp form with git@ and .git — the pre-fix asymmetry", () => {
    // Pre-fix: orgOf('git@github.com:acme-corp/widgets.git') returned
    // 'git@github.com:acme-corp' — while resolveRepoFromEnv and
    // resolveAllowedOrgs both handled the same spelling. A GITHUB_REPO set
    // ssh-form therefore broke the default app's installation discovery
    // (op:discover, no match) and the registry routing silently fell back to
    // the default App.
    expect(orgOf("git@github.com:acme-corp/widgets.git")).toBe("acme-corp");
    expect(orgOf("git@github.com:o/r")).toBe("o");
  });

  test("host form without a scheme (github.com:owner/repo)", () => {
    expect(orgOf("github.com:acme-corp/widgets")).toBe("acme-corp");
  });

  test("trims a trailing slash — a copy-pasted `owner/repo/` is the same repo", () => {
    // Pre-fix: `acme/widgets/` fell through both regexes and was returned
    // whole, so a registered org never resolved and minting silently fell
    // back to the default App (the same class of unmatchable-spelling bug
    // as the ssh-form asymmetry above).
    expect(orgOf("acme/widgets/")).toBe("acme");
    expect(orgOf("acme/widgets//")).toBe("acme");
    expect(orgOf("https://github.com/acme/widgets.git/")).toBe("acme");
    // `.git` behind a trailing slash strips both.
    expect(orgOf("acme/widgets.git/")).toBe("acme");
  });

  test("a bare org (no repo segment) is returned unchanged", () => {
    expect(orgOf("acme-corp")).toBe("acme-corp");
  });

  test("an empty string stays empty", () => {
    expect(orgOf("")).toBe("");
  });
});
