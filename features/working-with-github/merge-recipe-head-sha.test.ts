import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * "Merging your own PRs" lets the agent merge once CI is green, every thread
 * is resolved and the PR is mergeable — conditions it checks against the
 * PR's head at one moment. Pre-fix the merge PUT carried only
 * `merge_method`, so GitHub merged WHATEVER the head was when the PUT landed:
 * a commit pushed between the checks and the merge (a bot's merge commit, a
 * co-author's fixup, the agent's own late round) was squashed into main with
 * no CI run and no review — "never merge past a red check" broken by a race
 * the recipe itself opened. Branch protection is no backstop on a repo
 * without required checks (the catalog's own main has none). GitHub's merge
 * endpoint takes `sha` exactly for this: the merge 409s ("Head branch was
 * modified") unless the head still matches it. The recipe now reads the
 * head sha once, checks every condition against it, and pins the merge to it.
 */
const prompt = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "prompt.md"),
  "utf-8"
);

const fences: readonly string[] = [
  ...prompt.matchAll(/```bash[^\n]*\n([\s\S]*?)```/g),
].map((match) => match[1] ?? "");

const mergeFence =
  fences.find((fence) => fence.includes("pulls/PR_NUMBER/merge")) ?? "";

/** The merge call through its backslash continuations, up to the blank line. */
const mergeStart = mergeFence.indexOf('gh api "repos/${REPO}/pulls/PR_NUMBER/merge"');
const mergeCall =
  mergeStart < 0 ? "" : (mergeFence.slice(mergeStart).split("\n\n")[0] ?? "");

describe("the merge recipe pins the head sha its conditions were checked on", () => {
  test("the merge call exists", () => {
    expect(mergeCall).not.toBe("");
  });

  test("the head sha is read from the PR before the merge", () => {
    const read = mergeFence.indexOf("HEAD_SHA=$(");
    expect(read).toBeGreaterThanOrEqual(0);
    expect(mergeFence.slice(read)).toMatch(/^HEAD_SHA=\$\(GH_TOKEN="\$TOKEN" gh api "repos\/\$\{REPO\}\/pulls\/PR_NUMBER" --jq '\.head\.sha'\)/u);
    expect(read).toBeLessThan(mergeFence.indexOf(mergeCall));
  });

  test("the merge PUT sends that sha (as a string, via --raw-field)", () => {
    expect(mergeCall).toContain('--raw-field sha="$HEAD_SHA"');
  });

  test("the CI condition is checked on that same sha", () => {
    expect(mergeFence).toContain("commits/${HEAD_SHA}/check-runs");
  });
});
