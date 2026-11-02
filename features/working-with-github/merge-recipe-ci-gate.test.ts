import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * "Merging your own PRs" lets the agent merge once "every required check
 * passes", and the recipe is the only CI evidence it reads. Pre-fix that was
 * ONE unpaginated `GET /commits/{sha}/check-runs`, which has two blind spots:
 *
 * - GitHub serves 30 check runs per page by default. A head with more shows
 *   only the first 30, and the rest never show. Measured live: an
 *   OpenRouterIncubator/ori PR head (#4465) carries 31 runs, and the default
 *   page left out a cancelled `pr-metadata` run. A green rerun covered it
 *   there, but nothing on the page said a 31st run existed.
 * - Commit STATUSES (`POST /statuses/{sha}`: external CI, deploy previews,
 *   review bots such as that repo's "Devin Review") are a separate API that
 *   check-runs never lists, so a red status was invisible.
 *
 * The recipe now pages through every check run and reads the combined status
 * for the same pinned head sha.
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

/** The command lines (comments dropped) that read `path` for the head sha. */
const callsFor = (path: string): string[] =>
  mergeFence
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .filter((line) => line.includes(`commits/\${HEAD_SHA}/${path}`));

describe("the merge recipe's CI gate reads every check on the head sha", () => {
  test("the check-runs read pages through every run, 100 per page", () => {
    const [call] = callsFor("check-runs");
    expect(call).toBeDefined();
    expect(call).toContain("--paginate");
    expect(call).toContain("check-runs?per_page=100");
  });

  test("the commit statuses are read for the same head sha", () => {
    const [call] = callsFor("status");
    expect(call).toBeDefined();
    expect(call).toContain('gh api "repos/${REPO}/commits/${HEAD_SHA}/status');
  });

  test("both reads come before the merge PUT", () => {
    const merge = mergeFence.indexOf("pulls/PR_NUMBER/merge");
    expect(mergeFence.indexOf("/check-runs?per_page=100")).toBeLessThan(merge);
    expect(mergeFence.indexOf("/status?per_page=100")).toBeLessThan(merge);
  });
});

/**
 * "Every required check passes (no failures, nothing still pending)" is
 * vacuously true of an EMPTY check-run list, and an empty list is exactly
 * what the recipe reads right after the PR opens: GitHub creates the runs
 * only once the workflow is queued. Measured on this catalog: PRs #355-#357
 * opened at 12:21:27/34/41Z and their `test` runs started at 12:21:34/41/48Z
 * — a 7s window where `check-runs` answers `total_count: 0` and `/status`
 * answers `pending` with `total_count: 0`, the shape the recipe already
 * calls "no status was posted". The catalog's main is unprotected, so a run
 * that followed the recipe straight from step 6 read no red, nothing pending,
 * and squash-merged a head CI never tested. The gate now says an empty list
 * is not green.
 */
describe("the merge recipe's CI gate never reads an empty check-run list as green", () => {
  const commentary = mergeFence
    .split("\n")
    .filter((line) => line.trimStart().startsWith("#"))
    .join(" ");

  test("the recipe says an empty check-run list means CI has not started", () => {
    expect(commentary).toContain("An EMPTY list is not green");
    expect(commentary).toContain("Wait and read again");
  });

  test("that rule sits between the check-runs read and the merge PUT", () => {
    const rule = mergeFence.indexOf("An EMPTY list is not green");
    expect(rule).toBeGreaterThan(mergeFence.indexOf("/check-runs?per_page=100"));
    expect(rule).toBeLessThan(mergeFence.indexOf("pulls/PR_NUMBER/merge"));
  });

  test("the merge conditions list says no checks at all is not green", () => {
    const condition =
      prompt.split("\n").find((line) => line.startsWith("- **CI is green**")) ??
      "";
    expect(condition).toContain("No checks at all is not green");
  });
});
