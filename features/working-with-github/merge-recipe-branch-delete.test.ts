import { describe, expect, test } from "bun:test";

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    // call, not just the squash PUT. A squash-merge leaves the head branch
    // behind unless the repository deletes head branches on merge.
    expect(mergeFence).toContain("git/refs/heads/");
  });

  test("the recipe posts the promised summary comment (pulls/N/comments)", () => {
    expect(mergeFence).toContain("/comments");
  });
});

// OpenRouterIncubator/ori deletes head branches on merge
// (`delete_branch_on_merge: true`): its PR #4661 branch read 404 right after
// the squash, and a DELETE of a ref that is gone answers 422 `Reference does
// not exist`. The prompt said a squash-merge never deletes the branch, so the
// recipe's DELETE failed there on every merge and read as a broken step.
describe("the branch delete treats a branch the merge already deleted as done", () => {
  const start = mergeFence?.indexOf("# Delete the merged branch") ?? -1;
  const end = mergeFence?.indexOf("\n\n", start) ?? -1;
  const snippet = start === -1 || end === -1 ? "" : (mergeFence ?? "").slice(start, end);

  const run = (deleteExit: number, refExists: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "wwg-branch-delete-"));
    try {
      const stub = join(dir, "gh");
      writeFileSync(
        stub,
        `#!/bin/sh\ncase "$*" in\n  *"--method DELETE"*) [ ${deleteExit} = 0 ] || echo 'Reference does not exist (HTTP 422)' >&2; exit ${deleteExit} ;;\n  *git/ref/heads/*) ${refExists ? "exit 0" : "echo 'Not Found (HTTP 404)' >&2; exit 1"} ;;\nesac\nexit 2\n`,
      );
      chmodSync(stub, 0o755);
      const proc = Bun.spawnSync(["bash", "-c", snippet.replaceAll("BRANCH_NAME", "fix-x")], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, REPO: "acme/widgets", TOKEN: "t" },
        stderr: "pipe",
        stdout: "pipe",
      });
      return { code: proc.exitCode, out: proc.stdout.toString() };
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  };

  test("the recipe has the delete snippet", () => {
    expect(snippet).toContain("--method DELETE");
  });

  test("a delete that succeeds prints nothing more", () => {
    expect(run(0, false)).toEqual({ code: 0, out: "" });
  });

  test("a 422 on a branch the merge already deleted is done, not a failure", () => {
    const result = run(1, false);
    expect(result.code).toBe(0);
    expect(result.out).toContain("fix-x was already deleted on merge: done");
  });

  test("a failed delete of a branch that is still there is named as a failure", () => {
    expect(run(1, true).out).toContain("fix-x is still there: the delete failed");
  });

  test("the prompt no longer claims a squash-merge never deletes the branch", () => {
    expect(prompt).not.toContain("does NOT delete the head branch on its own");
    expect(prompt).toContain("delete_branch_on_merge");
  });
});
