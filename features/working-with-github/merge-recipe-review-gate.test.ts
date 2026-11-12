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
 *
 * "Latest review" must be the latest OPINIONATED one. `latestReviews` counts
 * a comment-only review too, so a reviewer who requested changes and then
 * commented shows COMMENTED there and the gate read no changes requested.
 * Live on OpenRouterIncubator/ori #4084 (perry-the-pr-reviewer:
 * CHANGES_REQUESTED, then two COMMENTED reviews):
 *
 *   latestReviews             perry-the-pr-reviewer COMMENTED
 *   latestOpinionatedReviews  perry-the-pr-reviewer CHANGES_REQUESTED
 *
 * The thread read took one page of 100. kubernetes/kubernetes#137133 carries
 * 119 threads, and all 14 unresolved ones sit past the first 100, so the gate
 * printed "unresolvedThreads":[] (real gh 2.63, 2026-11-12). It now pages
 * with `gh api graphql --paginate` over `$endCursor` and reads 14.
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
    expect(reviewRead).toContain("latestOpinionatedReviews(first: 100)");
    expect(reviewRead).toContain('select(.state == "CHANGES_REQUESTED")');
    expect(reviewRead).not.toContain("reviewDecision");
  });

  test("a comment-only review after a changes request cannot hide it", () => {
    const query = reviewRead.slice(0, reviewRead.indexOf("--jq"));
    expect(query).not.toMatch(/\blatestReviews\(/);
    expect(reviewRead).toContain(".latestOpinionatedReviews.nodes[]");
    expect(reviewRead).not.toContain(".latestReviews.nodes[]");
  });

  test("it lists every unresolved thread", () => {
    expect(reviewRead).toContain("reviewThreads(first: 100");
    expect(reviewRead).toContain("select(.isResolved | not)");
  });

  test("it reads every page of threads, not only the first 100", () => {
    expect(reviewRead).toMatch(/^gh api graphql --paginate /u);
    expect(reviewRead).toContain("$endCursor: String");
    expect(reviewRead).toContain("reviewThreads(first: 100, after: $endCursor)");
    expect(reviewRead).toContain("pageInfo { hasNextPage endCursor }");
  });

  test("the conditions no longer promise branch protection or a reviewDecision shortcut", () => {
    expect(prompt).not.toContain("Branch protection blocks merge otherwise.");
    expect(prompt).not.toContain(
      "the review decision is `APPROVED` or clean"
    );
  });
});
