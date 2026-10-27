import { describe, expect, test } from "bun:test";
// Regression: the TRUNCATED scp/ssh host-word spellings — `github.com:`,
// `git@github.com:`, `ssh://git@github.com:`, `https://github.com:` (a
// colon after the host word with NO path after it — a truncated
// `git remote -v` paste, the same copy-paste family as the bare-host and
// ported spellings the corpus already covers) — flowed through the
// resolvers RAW:
//
//   - `orgOf` answered `github.com:` / `git@github.com:` — a login no
//     installation owner can ever carry, so a registry row registered
//     from one was keyed on a host string (a dead row no mint can ever
//     derive) while the CLI confirmed it as the "org";
//   - `resolveAllowedOrgs` carried the same raw string as the allowlist
//     entry, so EVERY mint failed closed with "Refusing to mint a token …
//     not in the allowed-orgs allowlist (github.com:)" and no hint the
//     env var's spelling was the cause;
//   - `resolveRepoFromEnv` handed every `repos/{repo}` route the raw
//     `github.com:` — a 404 no route answers — so the health check's
//     round-trip and every Git-Data path targeted a repo that cannot
//     exist;
//   - `resolveConfigDirName` sanitized the raw string into
//     `git-github.com` / `https-github.com`, silently migrating the
//     registry/cache DB the moment GITHUB_REPO's spelling changed.
//
// The prompt's own `REPO=` sed recipe answers "" for every spelling in
// this corpus (verified live: `s#([a-zA-Z0-9+.-]*://)?([^@\s]+@)?[Gg]…[Cc]…[Oo]…[Mm][/:]##`
// empties a colon-terminated host word), and the ported spellings
// (`ssh://git@github.com:22`) already collapse to "" in every resolver —
// the truncated colon is the one tail the corpus missed. One spelling
// contract, four resolvers: the host-word-with-trailing-colon answers
// no owner and no repo.

import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";

const TRUNCATED_COLON_HOSTS: readonly string[] = [
  "github.com:",
  "https://github.com:",
  "git@github.com:",
  "ssh://git@github.com:",
  "GitHub.com:",
];

describe("truncated colon-host spellings resolve like their bare host", () => {
  test("orgOf answers no owner, never the raw host string", () => {
    for (const raw of TRUNCATED_COLON_HOSTS) {
      expect(orgOf(raw)).toBe("");
    }
  });

  test("resolveAllowedOrgs derives no login from the spelling", () => {
    for (const raw of TRUNCATED_COLON_HOSTS) {
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw })]).toEqual(
        []
      );
    }
  });

  test("resolveRepoFromEnv answers no repo, never the raw host string", () => {
    for (const raw of TRUNCATED_COLON_HOSTS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("");
    }
  });

  test("resolveConfigDirName takes the documented no-repo fallback", () => {
    for (const raw of TRUNCATED_COLON_HOSTS) {
      expect(
        resolveConfigDirName({ GITHUB_REPO: raw, INTERN_NAME: "" })
      ).toBe("intern");
    }
  });

  test("a colon-host REPO spelling keeps resolving to owner/repo in every resolver", () => {
    for (const raw of [
      "github.com:acme/widgets",
      "git@github.com:acme/widgets",
    ]) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("acme/widgets");
      expect(orgOf(raw)).toBe("acme");
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw })]).toEqual(
        ["acme"]
      );
      expect(
        resolveConfigDirName({ GITHUB_REPO: raw, INTERN_NAME: "" })
      ).toBe("widgets");
    }
  });

  test("a ported host (no path) still answers no owner and no repo", () => {
    for (const raw of [
      "github.com:22",
      "ssh://git@github.com:22",
      "https://github.com:443",
    ]) {
      expect(orgOf(raw)).toBe("");
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("");
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw })]).toEqual(
        []
      );
      expect(
        resolveConfigDirName({ GITHUB_REPO: raw, INTERN_NAME: "" })
      ).toBe("intern");
    }
  });
});