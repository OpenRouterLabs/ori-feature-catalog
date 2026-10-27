import { describe, expect, test } from "bun:test";
// Regression: a PADDING-ONLY path segment — a pasted URL whose one path
// segment carries nothing but separator-adjacent whitespace
// (`https://github.com/ /widgets`, `git@github.com: :o/r` — the same paste
// class the separator-adjacent strip exists for, reopened through the
// segment form). A GitHub login or repo name never carries a space, so the
// healthy answer is the same `owner/repo` tail the prompt REPO= recipe
// resolves to. Pre-fix the whitespace strip ran AFTER the interior-slash
// collapse, so the space-only segment blocked the collapse and the resolvers
// answered five different raw junk values (resolveRepoFromEnv and orgOf the
// raw URL, resolveAllowedOrgs an empty allowlist, resolveConfigDirName the
// healthy tail, the recipe the healthy pair) — the one-spelling contract
// broken across all four code resolvers.
import {
  orgOf,
  resolveConfigDirName,
} from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

describe("a padding-only path segment resolves like its de-padded spelling", () => {
  test.each([
    ["https://github.com/ /widgets", "widgets", "widgets"],
    ["https://github.com/  /o/r", "o/r", "o"],
    ["ssh://git@github.com/ /o/r", "o/r", "o"],
  ])("%s → repo %s, org %s", (spelling, repo, org) => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe(repo);
    expect(orgOf(spelling)).toBe(org);
    expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe(
      repo.split("/").at(-1) ?? repo
    );
    expect(
      [...resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling })].sort()
    ).toEqual([org]);
  });
});
