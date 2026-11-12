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

  const run = (deleteExit: number, refExists: boolean | "rate-limited") => {
    const dir = mkdtempSync(join(tmpdir(), "wwg-branch-delete-"));
    try {
      const stub = join(dir, "gh");
      writeFileSync(
        stub,
        `#!/bin/sh\ncase "$*" in\n  *"--method DELETE"*) [ ${deleteExit} = 0 ] || echo 'Reference does not exist (HTTP 422)' >&2; exit ${deleteExit} ;;\n  *git/ref/heads/*) ${refExists === "rate-limited" ? "echo 'API rate limit exceeded (HTTP 403)' >&2; exit 1" : refExists ? "exit 0" : "echo 'Not Found (HTTP 404)' >&2; exit 1"} ;;\nesac\nexit 2\n`,
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

  // Pre-fix ANY failed ref read printed "already deleted on merge: done": a
  // rate-limited DELETE and read (HTTP 403) claimed a branch gone that was
  // still there. Only a 404 proves it is gone.
  test("a ref read that fails for another reason never reads as deleted", () => {
    const result = run(1, "rate-limited");
    expect(result.out).not.toContain("already deleted on merge: done");
    expect(result.out).toContain("fix-x could not be read");
    expect(result.out).toContain("HTTP 403");
  });

  test("the prompt no longer claims a squash-merge never deletes the branch", () => {
    expect(prompt).not.toContain("does NOT delete the head branch on its own");
    expect(prompt).toContain("delete_branch_on_merge");
  });
});

// Git allows `#`, `+` and `%` in a branch name. Pre-fix both recipes put the
// name raw into the URL: gh reads a raw `#` as the start of a URL fragment and
// sends only what comes before it (live, with throwaway branches
// `wwg-probe-del` and `wwg-probe-del#fix` on OpenRouterLabs/ori-feature-catalog,
// the merge recipe's DELETE removed `wwg-probe-del`), and GitHub reads a raw
// `+` in `?sha=` as a space (404 on `wwg-probe+plus`).
describe("the branch name reaches gh encoded", () => {
  const ghArgs = (fence: string, branch: string): string[][] => {
    const dir = mkdtempSync(join(tmpdir(), "wwg-branch-encode-"));
    try {
      const log = join(dir, "calls");
      writeFileSync(
        join(dir, "gh"),
        `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a"; done >> "${log}"\necho >> "${log}"\nexit 0\n`,
      );
      chmodSync(join(dir, "gh"), 0o755);
      Bun.spawnSync(
        ["bash", "-c", fence.replaceAll("BRANCH_NAME", branch).replaceAll("branch-name", branch)],
        { env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, REPO: "acme/widgets", TOKEN: "t" } },
      );
      return readFileSync(log, "utf-8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.split("\u001f").filter((arg) => arg !== ""));
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  };

  const start = mergeFence?.indexOf("# Delete the merged branch") ?? -1;
  const end = mergeFence?.indexOf("\n\n", start) ?? -1;
  const deleteSnippet = start === -1 || end === -1 ? "" : (mergeFence ?? "").slice(start, end);

  test("the merge recipe deletes the branch it names, not the one before a `#`", () => {
    const [call] = ghArgs(deleteSnippet, "fix#12");
    expect(call).toContain("repos/acme/widgets/git/refs/heads/fix%2312");
  });

  test("a slash in the branch stays a path separator, and a `%` is encoded", () => {
    expect(ghArgs(deleteSnippet, "feat/50%off")[0]).toContain(
      "repos/acme/widgets/git/refs/heads/feat/50%25off",
    );
  });

  test("the step 7 signature check sends the branch as a field, never in a hand-written query", () => {
    const verifyFence = fences.find((fence) => fence.includes("verification.verified")) ?? "";
    const line = verifyFence.slice(0, verifyFence.indexOf("--jq"));
    const [call = []] = ghArgs(`${line} --jq .`, "fix#12+1");
    expect(call.filter((arg) => arg.includes("?"))).toEqual([]);
    expect(call).toContain("sha=fix#12+1");
    expect(call.slice(0, 3)).toEqual(["api", "-X", "GET"]);
  });
});
