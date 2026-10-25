import { describe, expect, test } from "bun:test";
// Regression: the HOSTLESS orgs-page path — bare `orgs/<org>` or
// `organizations/<org>` (the URL path copied without the github.com host) —
// is the same reserved-word spelling as the hosted `github.com/orgs/<org>`
// form. Pre-fix the four sibling resolvers disagreed on it:
//
//   - `orgOf` returned `orgs` (the reserved word read as an OWNER), so
//     `register-gh-app --org orgs/acme` persisted a dead row keyed `orgs`
//     (exit 0, confirmation `registered orgs …`) that no mint could ever
//     derive — the #101/#140 silent-dead-row class reopened through the
//     hostless paste;
//   - `resolveRepoFromEnv` returned `orgs/acme` whole, which every
//     `repos/{repo}` route 404s on (the word is a reserved host path,
//     never an owner login), while the prompt's own `REPO=` sed strips the
//     same spelling to `acme`;
//   - `resolveAllowedOrgs` put `orgs` in the allowlist, so every mint
//     failed CLOSED against a login no installation can ever own — with a
//     refusal message naming `orgs` as the allowlist, hiding the spelling
//     as the cause;
//   - `resolveConfigDirName` — the only sibling that already handled the
//     spelling — keyed the config dir `acme`, so the registry DB lived
//     under `acme` while its rows were keyed `orgs`.
//
// The fix routes the hostless spelling through the same org-extraction the
// hosted form already gets. A repo genuinely named `<org>` under an owner
// called `orgs` is unreachable by this spelling anyway — the reserved word
// never resolves as an owner login — and `acme/orgs` (a repo NAMED `orgs`
// under a real owner) is untouched: the repo regexes capture the owner
// first.

import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";
import {
  lookupApp,
  openGhAppRegistryDb,
  orgOf,
  registerApp,
  resolveConfigDirName,
} from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";

const HOSTLESS_PAGE_PATHS: string[] = [
  "orgs/acme",
  "organizations/acme",
  " orgs/acme ",
  "orgs/acme/teams",
  "organizations/acme/settings",
];

describe("the hostless orgs-page path resolves like its hosted sibling", () => {
  test.each(HOSTLESS_PAGE_PATHS)(
    "orgOf extracts the org from %s",
    (spelling: string) => {
      expect(orgOf(spelling)).toBe("acme");
    }
  );

  test.each(HOSTLESS_PAGE_PATHS)(
    "resolveRepoFromEnv returns the org for %s",
    (spelling: string) => {
      // A repo resolver cannot invent a repo from an orgs page; the org is
      // the same single-segment pass-through the hosted spelling keeps.
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe("acme");
    }
  );

  test.each(HOSTLESS_PAGE_PATHS)(
    "the allowlist carries the org for %s",
    (spelling: string) => {
      expect([
        ...resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling }),
      ]).toEqual(["acme"]);
    }
  );

  test("registerApp persists the org, not the reserved word, so mints can match the row", () => {
    const db = openGhAppRegistryDb(":memory:");
    registerApp(db, {
      appIdKey: "TEAM_GH_APP_ID",
      org: "orgs/acme",
      privateKeyKey: "TEAM_GH_APP_PRIVATE_KEY",
      purpose: "reviewer",
    });
    // The row the mint path looks up: orgOf("acme/widgets") === "acme".
    expect(lookupApp(db, "acme", "reviewer")).not.toBeNull();
    // The reserved word never keys a row.
    expect(lookupApp(db, "orgs", "reviewer")).toBeNull();
  });

  test("the config dir keeps agreeing with the registry key", () => {
    // Both derive "acme" from the same spelling — the #113 silent-DB-
    // migration class requires every resolver to answer the same.
    expect(resolveConfigDirName({ GITHUB_REPO: "orgs/acme" })).toBe("acme");
    expect(orgOf("orgs/acme")).toBe("acme");
  });

  test("a repo named orgs under a real owner is untouched", () => {
    expect(orgOf("acme/orgs")).toBe("acme");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "acme/orgs" })).toBe("acme/orgs");
  });

  test("the mint routing note names the org a registered row matches", () => {
    // mintInstallationToken({targetRepo: "orgs/acme"}) derives its registry
    // key via orgOf — after the fix it routes to (acme, purpose), matching
    // the row registerApp persisted, instead of the dead `orgs` key.
    expect(orgOf("orgs/acme")).toBe(orgOf("acme/widgets"));
  });
});
