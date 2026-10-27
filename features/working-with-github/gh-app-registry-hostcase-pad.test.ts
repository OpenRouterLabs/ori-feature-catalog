import { describe, expect, test } from "bun:test";

import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";

// A PADDED, HOST-CASE bare-host spelling (`" GitHub.com "`, `" git@GitHub.com "`
// — a copy-paste that kept both the address bar's capitalization and its
// surrounding whitespace) is a spelling the sibling resolvers already answer
// honestly: `resolveRepoFromEnv` and `resolveAllowedOrgs` trim first, so they
// resolve it to no owner at all, exactly like the lowercase padded forms.
// `orgOf` runs its `^`-anchored case-lower regex on `trimStart()` output only,
// so the TRAILING pad defeats the `$`-anchored lookahead, the mixed-case host
// falls every anchored `github.com` branch below, and the raw junk string
// (`"GitHub.com"`, `"https://GitHub.com"`) is returned whole as the "org" —
// a registry key and allowlist entry no mint can ever derive, and a config
// dir (`github.com`) no sibling resolver's key ever names. The same shape hits
// `resolveConfigDirName` (it trims via the same two-step): `" https://GitHub.com "`
// keys the registry/cache DB at `https-github.com`, silently migrating the
// store the moment the env var's spelling gains a trailing space — the exact
// #113 class its own comments document, reopened through the padded host-case
// bare host.

describe("orgOf resolves a padded host-case bare host to no owner", () => {
  test.each([
    " GitHub.com ",
    "GitHub.com ",
    " GitHub.com",
    " git@GitHub.com ",
    " https://GitHub.com ",
    " HTTPS://GitHub.com ",
    "GitHub.com\t",
  ])("orgOf(%p) answers no owner, never the raw host string", (spelling) => {
    expect(orgOf(spelling)).toBe("");
  });

  test.each([
    " GitHub.com ",
    " https://GitHub.com ",
    " git@GitHub.com ",
  ])(
    "resolveConfigDirName(%p) keeps the documented intern fallback",
    (spelling) => {
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe("intern");
    }
  );

  test("a padded lowercase bare host keeps its honest no-owner answer", () => {
    expect(orgOf(" github.com ")).toBe("");
    expect(orgOf(" https://github.com ")).toBe("");
  });

  test("a padded host-case spelling WITH a path still resolves (corpus guard)", () => {
    expect(orgOf(" https://GitHub.com/o/r ")).toBe("o");
    expect(orgOf(" https://GitHub.com/acme ")).toBe("acme");
  });
});
