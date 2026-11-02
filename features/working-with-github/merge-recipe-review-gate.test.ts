import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * "Merging your own PRs" lists two review conditions (every thread resolved,
 * no changes requested), but pre-fix the recipe read neither. It also told
 * the agent that the review decision should be "APPROVED or clean", and two
 * live OpenRouterIncubator/ori PRs show where that goes wrong:
 *
 *   #4443  reviewDecision null       latest review CHANGES_REQUESTED
 *   #4469  reviewDecision APPROVED   one unresolved review thread
 *
 * `reviewDecision` is null on a repo that requires no reviews, even while a
 * reviewer has requested changes, so null reads as "clean". The bullet also
 * said branch protection blocks an unresolved thread, but that only holds
 * where protection requires thread resolution. This catalog's own `main` is
 * unprotected, so the recipe is the only gate. The recipe now reads each
 * reviewer's latest review and every thread through GraphQL, the only API
 * that reports thread resolution.
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

const reviewRead = mergeFence.slice(mergeFence.indexOf("gh api graphql"));

describe("the merge recipe reads the review conditions it lists", () => {
  test("a GraphQL read of the PR's reviews and threads sits before the merge PUT", () => {
    const read = mergeFence.indexOf("gh api graphql");
    expect(read).toBeGreaterThanOrEqual(0);
    expect(read).toBeLessThan(mergeFence.indexOf("pulls/PR_NUMBER/merge"));
    expect(reviewRead).toContain("-F number=PR_NUMBER");
  });

  test("it keys changes-requested on each reviewer's latest review, not reviewDecision", () => {
    expect(reviewRead).toContain("latestReviews(first: 100)");
    expect(reviewRead).toContain('select(.state == "CHANGES_REQUESTED")');
    expect(reviewRead).not.toContain("reviewDecision");
  });

  test("it lists every unresolved thread", () => {
    expect(reviewRead).toContain("reviewThreads(first: 100)");
    expect(reviewRead).toContain("select(.isResolved | not)");
  });

  test("the conditions no longer promise branch protection or a reviewDecision shortcut", () => {
    expect(prompt).not.toContain("Branch protection blocks merge otherwise.");
    expect(prompt).not.toContain(
      "the review decision is `APPROVED` or clean"
    );
  });
});
