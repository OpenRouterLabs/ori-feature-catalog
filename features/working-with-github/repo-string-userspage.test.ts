// Regression (the users-page paste class): `github.com/users/<login>` is
// the canonical user-profile URL (also `api.github.com/users/<login>`, and
// the hostless `users/<login>` paste), the exact sibling of the orgs-page
// spelling `github.com/orgs/<org>` that #169/#203 closed. `users` is a
// reserved host path on github.com, never an owner login — the profile page
// names a USER, and the login it names is the owner every downstream key
// must derive.
//
// Pre-fix every resolver keyed on the reserved WORD instead:
//
//   - `resolveRepoFromEnv` → "users/acme" (a fake owner/repo pair — `repos`
//     is reserved on the REST host, `users` on the web host: every
//     `repos/users/acme` route 404s, verified live);
//   - `orgOf` → "users" (a registry key no mint can ever derive from a real
//     repo string — a registered App for the user's org is silently
//     bypassed, every mint falls back to the default App);
//   - `resolveAllowedOrgs` → {"users"} (a login no installation owner can
//     ever carry, so every mint fails closed with no hint the env var's
//     spelling was the cause);
//   - `resolveConfigDirName` → "acme" — the ONLY resolver that read past the
//     reserved word (its own hostless branch), so four resolvers disagreed
//     on one spelling, violating the README's one-spelling contract.
//
// The fix consumes `users` exactly like `orgs`/`organizations` wherever
// those reserved words are already consumed, so the profile paste resolves
// to the login it names. A user genuinely NAMED "users" is unreachable by
// this spelling anyway — the reserved word never resolves as an owner
// login on github.com — the same argument the orgs branch makes.
import { describe, expect, test } from "bun:test";

import { orgOf, resolveConfigDirName } from "@ori-monorepo/working-with-github/gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

const USERS_PAGE_SPELLINGS: readonly string[] = [
  "https://github.com/users/acme",
  "github.com/users/acme",
  "users/acme",
  "https://api.github.com/users/acme",
];

describe("a users-page paste resolves to the login it names, never the reserved word", () => {
  test("orgOf consumes the users path word like orgs/organizations", () => {
    for (const spelling of USERS_PAGE_SPELLINGS) {
      expect(orgOf(spelling)).toBe("acme");
    }
  });

  test("resolveRepoFromEnv never builds the fake owner/repo pair users/<login>", () => {
    for (const spelling of USERS_PAGE_SPELLINGS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe("acme");
    }
  });

  test("resolveAllowedOrgs keys the allowlist on the login, so mints do not fail closed", () => {
    for (const spelling of USERS_PAGE_SPELLINGS) {
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling })]).toEqual(["acme"]);
    }
  });

  test("resolveConfigDirName keeps its existing answer (the login) — now agreeing with the rest", () => {
    for (const spelling of USERS_PAGE_SPELLINGS) {
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe("acme");
    }
  });

  test("the orgs-page branches keep their established answers beside the new users ones", () => {
    expect(orgOf("https://github.com/orgs/acme")).toBe("acme");
    expect(orgOf("https://github.com/organizations/acme")).toBe("acme");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "https://github.com/orgs/acme" })).toBe("acme");
    expect(orgOf("https://github.com/users")).toBe("");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "https://github.com/users" })).toBe("");
  });
});
