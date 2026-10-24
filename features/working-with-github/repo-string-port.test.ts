import { describe, expect, test } from "bun:test";
// A git remote -v copy-paste with an explicit ssh PORT ("ssh://git@github.com:22/owner/repo.git")
// is a spelling the resolvers normalize WRONG today: the port digits become the "owner" segment,
// so orgOf() yields "22", resolveRepoFromEnv() yields "22/widgets", and resolveAllowedOrgs() carries
// "22" — every route 404s / every mint fails closed with no hint the spelling was the cause.
// This is the same defect class the closed issues fixed for other URL spellings (#159 deep URL,
// #169/#175/#177 colon-host): a copy-paste a host produces that resolves to a fake owner/repo.
import { orgOf } from "./gh-app-registry.ts";
import {
  resolveAllowedOrgs,
  isAllowlistedOrg,
} from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

const PORTED = "ssh://git@github.com:22/acme/widgets.git";

describe("an ssh URL with an explicit port resolves like every other spelling", () => {
  test("resolveRepoFromEnv keeps the owner/repo, not the port", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: PORTED })).toBe("acme/widgets");
  });
  test("orgOf resolves to the org, not the port digits", () => {
    expect(orgOf(PORTED)).toBe("acme");
  });
  test("resolveAllowedOrgs allowlists the org, so mints do not fail closed", () => {
    const allowed = resolveAllowedOrgs(undefined, { GITHUB_REPO: PORTED });
    expect(isAllowlistedOrg("acme", allowed)).toBe(true);
    expect(isAllowlistedOrg("22", allowed)).toBe(false);
  });
});
