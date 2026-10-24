import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The "Merging your own PRs" section promises "merge it (squash + delete
 * branch) via the REST API and post a brief summary comment" — but its fenced
 * recipe carried ONLY the squash PUT. An agent following the prompt verbatim
 * left the remote branch behind (the branch-delete step had no recipe line),
 * and never posted the promised summary comment. The worktree-cleanup sweep
 * later removes the local worktree and its local branch, but the REMOTE ref
 * lingers forever — and the very next run's `git worktree add` on a reused
 * branch name fails with "branch exists" until a human deletes it by hand.
 */
const prompt = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "prompt.md"),
  "utf-8"
);

const fences: readonly string[] = [
  ...prompt.matchAll(/```bash[^\n]*\n([\s\S]*?)```/g),
].map((match) => match[1] ?? "");

const mergeFence = fences.find((fence) =>
  fence.includes("pulls/PR_NUMBER/merge")
);

describe("the merge recipe keeps its own promised contract", () => {
  test("the merge fence exists", () => {
    expect(mergeFence).toBeDefined();
  });

  test("the recipe deletes the merged branch (refs/heads/ delete route)", () => {
    // "squash + delete branch" — the recipe must carry the branch-delete
    // call, not just the squash PUT. A squash-merge does NOT delete the head
    // branch on its own (the web UI's checkbox is not the API default).
    expect(mergeFence).toContain("git/refs/heads/");
  });

  test("the recipe posts the promised summary comment (pulls/N/comments)", () => {
    expect(mergeFence).toContain("/comments");
  });
});
