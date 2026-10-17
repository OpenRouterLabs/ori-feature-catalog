import { describe, expect, test } from "bun:test";

import { parseWorktreeList } from "./cleanup-worktrees-core.ts";

const WORKTREE_LIST = [
  "worktree /tmp/worktrees/owner-repo/branch-a",
  "HEAD abc123",
  "branch refs/heads/branch-a",
  "",
  "worktree /tmp/worktrees/owner-repo/branch-b",
  "HEAD def456",
  "branch refs/heads/branch-b",
  "",
].join("\n");

describe("parseWorktreeList", () => {
  test("parses multiple blank-line-separated entries", () => {
    expect(parseWorktreeList(WORKTREE_LIST)).toEqual([
      {
        branch: "branch-a",
        path: "/tmp/worktrees/owner-repo/branch-a",
      },
      {
        branch: "branch-b",
        path: "/tmp/worktrees/owner-repo/branch-b",
      },
    ]);
  });

  test("skips a detached/bare entry with no branch line", () => {
    const output = [
      "worktree /tmp/worktrees/owner-repo/main",
      "HEAD abc123",
      "bare",
      "",
    ].join("\n");
    expect(parseWorktreeList(output)).toEqual([]);
  });

  test("empty output → empty list", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});
