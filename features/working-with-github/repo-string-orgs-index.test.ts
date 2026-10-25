import { describe, expect, test } from "bun:test";
// Regression: the ORGANIZATIONS-page INDEX URL — `https://github.com/orgs`
// (and `/organizations`, `github.com:organizations`, the ported ssh forms) —
// carries the reserved host-path word with NO org segment after it: the page
// that LISTS your organizations, not one of them. Copy-pasted into
// `GITHUB_REPO` (or `--org`), every resolver resolved the reserved word itself
// as the owner:
//
//   - `resolveRepoFromEnv` returned `orgs`, so the health check round-tripped
//     `GET /repos/orgs` — a permanent 404 named after a host path (and
//     `gh --repo orgs` reports a repo no route answers);
//   - `orgOf` returned `orgs`, so `register-gh-app --org
//     https://github.com/orgs` persisted a registry row keyed on the reserved
//     word — no mint can ever derive that key from a real repo string (the
//     #101/#143 dead-row class the deep orgs-page branch already closes for
//     the `orgs/<org>` spelling);
//   - `resolveAllowedOrgs` put `orgs` in the allowlist, so every mint failed
//     closed against a login no installation can ever own;
//   - `resolveConfigDirName` named the config dir `orgs`, silently migrating
//     the registry/cache DB and orphaning the old rows (#113's class).
//
// `orgs`/`organizations` are reserved host paths on github.com, never an
// owner login — the invariant the `orgs/<org>` branches already encode, and
// the reason the INDEX spelling (no org after the word) must resolve to NO
// owner at all rather than to the word. The org-naming spellings
// (`orgs/<org>`) keep their existing behavior, and a REPO named `orgs` under
// a real owner (`acme/orgs`) is untouched — the repo regexes run past the
// host path, so `orgs` as a repo segment never reaches the index branch.

import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";

const INDEX_URLS: readonly string[] = [
  "https://github.com/orgs",
  "https://github.com/organizations",
  "http://github.com/organizations",
  "github.com/orgs",
  "git@github.com:organizations",
  "ssh://git@github.com:22/orgs",
  "https://github.com:443/organizations",
];

describe("the organizations-page INDEX spellings resolve to no owner at all", () => {
  test("orgOf returns the empty string, never the reserved host-path word", () => {
    // The registry call sites treat "" as "no derivable org":
    // register-gh-app.ts's normalizedOrg guard fails loudly naming the
    // argument, and readGhAppCredentials falls back to the sole-installation
    // discovery path — never a registry row keyed on `orgs`.
    for (const spelling of INDEX_URLS) {
      expect(orgOf(spelling)).toBe("");
    }
  });

  test("resolveRepoFromEnv returns the empty string, never a fake repo", () => {
    // A repo resolver cannot invent a repo from the index page: `""` is the
    // CLI/schedule "cannot resolve which repo" signal (commit-via-api's
    // `--repo (or set GITHUB_REPO)` diagnostic, the health check's die),
    // never `GET /repos/orgs`' permanent 404.
    for (const spelling of INDEX_URLS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe("");
    }
  });

  test("resolveAllowedOrgs is empty, so every mint fails closed honestly", () => {
    // The allowlist derived from the index spelling is EMPTY — the
    // documented fail-closed default for "no owner derivable" — instead of
    // carrying a login no installation can ever own.
    for (const spelling of INDEX_URLS) {
      expect([
        ...resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling }),
      ]).toEqual([]);
    }
  });

  test("resolveConfigDirName falls back to intern, never the reserved word", () => {
    // The config-dir name must not silently migrate to `orgs` (orphaning
    // the registry/cache DB rows): with no repo name derivable from the
    // index spelling, the documented fallback is `intern`.
    for (const spelling of INDEX_URLS) {
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe("intern");
    }
  });
});

describe("the org-NAMING spellings keep their resolved org", () => {
  test("the organizations-page URL with an org segment still resolves to that org", () => {
    expect(orgOf("https://github.com/orgs/acme")).toBe("acme");
    expect(orgOf("https://github.com/organizations/acme/settings")).toBe(
      "acme"
    );
    expect(
      resolveRepoFromEnv({ GITHUB_REPO: "https://github.com/orgs/acme" })
    ).toBe("acme");
    expect([
      ...resolveAllowedOrgs(undefined, {
        GITHUB_REPO: "https://github.com/organizations/acme",
      }),
    ]).toEqual(["acme"]);
  });

  test("a repo literally named orgs under a real owner is untouched", () => {
    // `acme/orgs` is a repo named `orgs` — the repo regexes capture the
    // owner past the host path, so the index branch never fires.
    expect(orgOf("acme/orgs")).toBe("acme");
    expect(orgOf("https://github.com/acme/orgs/tree/main")).toBe("acme");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "acme/orgs" })).toBe("acme/orgs");
  });

  test("the bare owner word without a host keeps its pass-through", () => {
    // A bare `organizations` (no github.com host, no org segment) is the
    // hostless INDEX spelling of the same page — it names no owner, so it
    // resolves to NO org (the loud-failure contract the hosted index
    // spelling already follows). A bare `orgs` word, though, is also the
    // documented BARE-OWNER pass-through shape for a login spelled `orgs`:
    // the org-naming branch (`orgs/<org>`) owns the reserved-word reading,
    // so the bare word keeps the honest pass-through discovery refuses
    // ("no installation for org orgs") rather than a silent empty key.
    expect(orgOf("organizations")).toBe("");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "organizations" })).toBe("");
    expect(resolveConfigDirName({ GITHUB_REPO: "organizations" })).toBe(
      "intern"
    );
    expect([
      ...resolveAllowedOrgs(undefined, { GITHUB_REPO: "organizations" }),
    ]).toEqual([]);
    expect(orgOf("orgs")).toBe("orgs");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "orgs" })).toBe("orgs");
  });
});
