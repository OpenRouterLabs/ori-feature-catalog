import { describe, expect, test } from "bun:test";
// The schedule's repo resolution must be the feature's shared
// `resolveRepoFromEnv` (commit-api-core.ts), never a private re-implementation:
// a local duplicate drifts as the shared resolver grows new tolerated
// spellings, and the `GET /repos/{repo}` round-trip then 404s on a spelling
// every sibling path accepts (the same drift class #108 closed for
// worktree-cleanup's resolveRepoDir). Pre-fix this file carried its own
// copy. This suite pins the dedup: the schedule must import the shared
// resolver and define no local one (a source-text contract, the same style
// prompt-recipes.test.ts pins the prompt's copy-paste recipes with), and the
// shared resolver must keep answering the full spelling set.
//
// The schedule's own module is NOT imported here: `bun test` runs this file
// on a fresh checkout where `ori` (the schedule's only other import) is a
// gitignored local SDK, so a value-import would fail with `Cannot find
// package 'ori'`. The source-text assertions below pin the contract without
// executing the module.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRepoFromEnv } from "@ori-monorepo/working-with-github/commit-api-core.ts";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "schedule.ts"),
  "utf-8"
);

const SPELLINGS: readonly {
  readonly normalized: string;
  readonly raw: string;
}[] = [
  { normalized: "acme/widgets", raw: "acme/widgets" },
  { normalized: "acme/widgets", raw: "https://github.com/acme/widgets" },
  {
    normalized: "acme/widgets",
    raw: "https://github.com/acme/widgets.git",
  },
  { normalized: "acme/widgets", raw: "git@github.com:acme/widgets.git" },
  { normalized: "acme/widgets", raw: "https://github.com/acme/widgets/" },
];

describe("gh-auth-health schedule repo resolution", () => {
  test("imports the shared resolver, defines no local copy", () => {
    expect(source).toContain(
      'resolveRepoFromEnv } from "@ori-monorepo/working-with-github/commit-api-core.ts"'
    );
    expect(source).not.toMatch(
      /const resolveRepo\b|function resolveRepo\b/
    );
  });

  for (const { normalized, raw } of SPELLINGS) {
    test(`resolves ${raw} through the shared resolver`, () => {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe(normalized);
    });
  }

  test("empty/unset GITHUB_REPO resolves to the empty string", () => {
    expect(resolveRepoFromEnv({})).toBe("");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "   " })).toBe("");
  });
});