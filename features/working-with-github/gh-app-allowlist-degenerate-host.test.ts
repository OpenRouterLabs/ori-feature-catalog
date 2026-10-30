import { describe, expect, test } from "bun:test";

import { resolveAllowedOrgs } from "./gh-app-github-api.ts";

// The chain's two degenerate-host branches must FALL THROUGH, never return
// early: a `GITHUB_REPO` spelled as a raw.githubusercontent.com paste with a
// sub-two-segment tail (`https://raw.githubusercontent.com/acme`) or as an
// api.github.com INDEX page (`api.github.com/orgs`, `/users`, `/repos`) names
// no owner, so the repo source contributes nothing — but the sources ABOVE it
// (an explicit `allowedOrgs` override, a set `GH_APP_ALLOWED_ORGS`) must still
// be allowed to name the whole allowlist. Pre-fix both branches returned an
// empty set outright, silently discarding the caller's own list and failing
// every mint closed — the exact "one source present never masks another"
// contract `gh-app-allowlist-sources.test.ts` pins for the github.com-host
// degenerate spellings, reopened through the api/raw-host shapes.

describe("resolveAllowedOrgs — degenerate api/raw-host repo spellings never mask the other sources", () => {
  test("an explicit override survives a raw-host paste with a sub-2-segment tail", () => {
    const allowed = resolveAllowedOrgs(["acme-corp"], {
      GITHUB_REPO: "https://raw.githubusercontent.com/acme",
    });
    expect(Array.from(allowed)).toEqual(["acme-corp"]);
  });

  test("an explicit override survives the raw host with a port and one segment", () => {
    const allowed = resolveAllowedOrgs(["acme-corp"], {
      GITHUB_REPO: "https://raw.githubusercontent.com:443/acme",
    });
    expect(Array.from(allowed)).toEqual(["acme-corp"]);
  });

  test("an explicit override survives the api-host organizations index", () => {
    const allowed = resolveAllowedOrgs(["acme-corp"], {
      GITHUB_REPO: "api.github.com/orgs",
    });
    expect(Array.from(allowed)).toEqual(["acme-corp"]);
  });

  test("a set GH_APP_ALLOWED_ORGS survives the api-host organizations index", () => {
    const allowed = resolveAllowedOrgs(undefined, {
      GH_APP_ALLOWED_ORGS: "acme-corp",
      GITHUB_REPO: "api.github.com/orgs",
    });
    expect(Array.from(allowed)).toEqual(["acme-corp"]);
  });

  test("a set GH_APP_ALLOWED_ORGS survives the short raw-host tail", () => {
    const allowed = resolveAllowedOrgs(undefined, {
      GH_APP_ALLOWED_ORGS: "acme-corp",
      GITHUB_REPO: "https://raw.githubusercontent.com/acme",
    });
    expect(Array.from(allowed)).toEqual(["acme-corp"]);
  });

  test("with no other source, the same spellings stay empty (fail-closed, unchanged)", () => {
    expect(
      Array.from(
        resolveAllowedOrgs(undefined, { GITHUB_REPO: "api.github.com/orgs" })
      )
    ).toEqual([]);
    expect(
      Array.from(
        resolveAllowedOrgs(undefined, {
          GITHUB_REPO: "https://raw.githubusercontent.com/acme",
        })
      )
    ).toEqual([]);
    expect(
      Array.from(
        resolveAllowedOrgs(undefined, { GITHUB_REPO: "api.github.com/repos" })
      )
    ).toEqual([]);
  });
});
