import { describe, expect, test } from "bun:test";

import { resolveAllowedOrgs } from "./gh-app-github-api.ts";

// A caller's explicit override array is the FIRST source of the allowlist —
// `GhAppConfigDeps.allowedOrgs` passes one straight through
// (`GhAppConfigLayer`), and the documented precedence is
// "explicit `override` (an array, from a caller) → the `GH_APP_ALLOWED_ORGS`
// env var → the owner of `GITHUB_REPO`". Pre-fix the chain was
// `override ?? fromEnv ?? fromRepo` — a nullish chain, so ONE present source
// masked the rest. A caller that supplied an override while the live env
// carried a GITHUB_REPO spelling resolving to no owner (the orgs-page index,
// a bare `organizations` word) silently minted with an EMPTY allowlist:
// the caller's explicit list vanished and discovery failed closed on every
// installation. The env var owes the same chain to the repo owner: a set var
// with blank/whitespace entries is "no real logins", not "allow-none".
describe("resolveAllowedOrgs — one source present never masks another", () => {
  test("an explicit override survives a GITHUB_REPO that resolves to no owner", () => {
    const allowed = resolveAllowedOrgs(["acme-corp"], {
      GITHUB_REPO: "organizations",
    });
    expect(Array.from(allowed)).toEqual(["acme-corp"]);
  });

  test("an explicit override survives the hosted orgs-page index spelling", () => {
    const allowed = resolveAllowedOrgs(["acme-corp"], {
      GITHUB_REPO: "https://github.com/orgs",
    });
    expect(Array.from(allowed)).toEqual(["acme-corp"]);
  });

  test("an explicit override wins over a set GH_APP_ALLOWED_ORGS", () => {
    const allowed = resolveAllowedOrgs(["acme-corp"], {
      GH_APP_ALLOWED_ORGS: "other-org",
      GITHUB_REPO: "acme/widgets",
    });
    expect(Array.from(allowed)).toEqual(["acme-corp"]);
  });

  test("a set-but-blank GH_APP_ALLOWED_ORGS falls back to the repo owner", () => {
    const allowed = resolveAllowedOrgs(undefined, {
      GH_APP_ALLOWED_ORGS: "  ",
      GITHUB_REPO: "acme/widgets",
    });
    expect(Array.from(allowed)).toEqual(["acme"]);
  });

  test("a blank override entry falls back to the env var", () => {
    const allowed = resolveAllowedOrgs(["   "], {
      GH_APP_ALLOWED_ORGS: "acme-corp",
      GITHUB_REPO: "acme/widgets",
    });
    expect(Array.from(allowed)).toEqual(["acme-corp"]);
  });

  test("the documented precedence stands when only one source exists", () => {
    expect(
      Array.from(
        resolveAllowedOrgs(undefined, {
          GH_APP_ALLOWED_ORGS: "acme-corp, other",
        })
      )
    ).toEqual(["acme-corp", "other"]);
    expect(
      Array.from(resolveAllowedOrgs(undefined, { GITHUB_REPO: "acme/widgets" }))
    ).toEqual(["acme"]);
    expect(
      Array.from(
        resolveAllowedOrgs(["acme-corp", "  ", "Other"], {})
      )
    ).toEqual(["acme-corp", "other"]);
  });

  test("no source at all stays empty (fail closed, unchanged)", () => {
    expect(Array.from(resolveAllowedOrgs(undefined, {}))).toEqual([]);
    expect(
      Array.from(
        resolveAllowedOrgs(undefined, {
          GITHUB_REPO: "https://github.com/orgs",
        })
      )
    ).toEqual([]);
  });
});