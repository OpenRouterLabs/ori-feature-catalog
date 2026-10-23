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

  test("keeps a detached entry (no branch) with its detached marker", () => {
    const output = [
      "worktree /tmp/worktrees/owner-repo/main",
      "HEAD abc123",
      "detached",
      "",
    ].join("\n");
    expect(parseWorktreeList(output)).toEqual([
      { detached: true, path: "/tmp/worktrees/owner-repo/main" },
    ]);
  });

  test("keeps a bare entry (no branch, no detached marker)", () => {
    // A bare entry must stay in the list too: dropping it made a worktree git
    // knows about fall through to the stray report, whose detail claims git
    // does NOT know about the directory.
    const output = [
      "worktree /tmp/worktrees/owner-repo/bare",
      "HEAD abc123",
      "bare",
      "",
    ].join("\n");
    expect(parseWorktreeList(output)).toEqual([
      { path: "/tmp/worktrees/owner-repo/bare" },
    ]);
  });

  test("parses a locked entry, with and without a lock reason", () => {
    const output = [
      "worktree /tmp/worktrees/owner-repo/locked-reason",
      "HEAD abc123",
      "branch refs/heads/locked-reason",
      "locked added with --lock",
      "",
      "worktree /tmp/worktrees/owner-repo/locked-plain",
      "HEAD abc123",
      "branch refs/heads/locked-plain",
      "locked",
      "",
    ].join("\n");
    expect(parseWorktreeList(output)).toEqual([
      {
        branch: "locked-reason",
        locked: true,
        path: "/tmp/worktrees/owner-repo/locked-reason",
      },
      {
        branch: "locked-plain",
        locked: true,
        path: "/tmp/worktrees/owner-repo/locked-plain",
      },
    ]);
  });

  test("empty output → empty list", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});
