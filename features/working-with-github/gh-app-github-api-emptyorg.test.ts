import { describe, expect, test } from "bun:test";

import { resolveAllowedOrgs } from "./gh-app-github-api.ts";

// The allowlist's documented precedence: explicit GH_APP_ALLOWED_ORGS → the
// owner of GITHUB_REPO. An operator who CLEARS the var (systemd
// `Environment=GH_APP_ALLOWED_ORGS=` resets, compose interpolation of an unset
// variable, a blank line in an env file) must fall back to the documented
// default — not fail every mint closed with an allow-none set. Pre-fix, the
// empty string split into `[]` (an ARRAY, not undefined), the `fromEnv` branch
// won, and the GITHUB_REPO-owner fallback never ran.

describe("resolveAllowedOrgs — an empty GH_APP_ALLOWED_ORGS falls back to the GITHUB_REPO owner", () => {
  test('an empty-string GH_APP_ALLOWED_ORGS falls back to the repo owner', () => {
    const allowed = resolveAllowedOrgs(undefined, {
      GH_APP_ALLOWED_ORGS: "",
      GITHUB_REPO: "acme-corp/widgets",
    });
    expect(Array.from(allowed)).toEqual(["acme-corp"]);
  });

  test("a whitespace-only GH_APP_ALLOWED_ORGS falls back to the repo owner", () => {
    const allowed = resolveAllowedOrgs(undefined, {
      GH_APP_ALLOWED_ORGS: "   ",
      GITHUB_REPO: "acme-corp/widgets",
    });
    expect(Array.from(allowed)).toEqual(["acme-corp"]);
  });

  test("a set var still wins over the repo owner (unchanged behaviour)", () => {
    const allowed = resolveAllowedOrgs(undefined, {
      GH_APP_ALLOWED_ORGS: "acme-corp, other-org",
      GITHUB_REPO: "acme-corp/widgets",
    });
    expect(Array.from(allowed)).toEqual(["acme-corp", "other-org"]);
  });

  test("with no repo either, the empty allowlist stays empty (fail closed, unchanged)", () => {
    const allowed = resolveAllowedOrgs(undefined, {
      GH_APP_ALLOWED_ORGS: "",
    });
    expect(Array.from(allowed)).toEqual([]);
  });
});
