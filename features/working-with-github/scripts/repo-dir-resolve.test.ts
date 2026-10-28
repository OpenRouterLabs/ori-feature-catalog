import { describe, expect, test } from "bun:test";

import { parseCleanupArgs } from "./cleanup-worktrees.ts";

describe("the CLI's --repo-dir default (the #75 class, closed for the schedule only)", () => {
  test("with ORI_INTERN_WORKSPACE_ROOT set and no --repo-dir, the git commands run from the workspace checkout", () => {
    const args = parseCleanupArgs(
      ["--dry-run"],
      {
        GH_APP_ID: "",
        GITHUB_REPO: "acme/widgets",
        ORI_INTERN_WORKSPACE_ROOT: "/tmp/checkout-root",
      },
      "/tmp/not-a-git-dir"
    );
    expect(args.repoDir).toBe("/tmp/checkout-root");
  });

  test("an explicit --repo-dir still wins over the env var", () => {
    const args = parseCleanupArgs(
      ["--repo-dir", "/tmp/explicit"],
      {
        GH_APP_ID: "",
        GITHUB_REPO: "acme/widgets",
        ORI_INTERN_WORKSPACE_ROOT: "/tmp/checkout-root",
      },
      "/tmp/not-a-git-dir"
    );
    expect(args.repoDir).toBe("/tmp/explicit");
  });

  test("with the env var unset, cwd stays the default", () => {
    const args = parseCleanupArgs(
      ["--dry-run"],
      { GH_APP_ID: "", GITHUB_REPO: "acme/widgets" },
      "/tmp/cwd-default"
    );
    expect(args.repoDir).toBe("/tmp/cwd-default");
  });

  test("a whitespace-only env var is unset, never a dead path", () => {
    const args = parseCleanupArgs(
      ["--dry-run"],
      {
        GH_APP_ID: "",
        GITHUB_REPO: "acme/widgets",
        ORI_INTERN_WORKSPACE_ROOT: "   ",
      },
      "/tmp/cwd-default"
    );
    expect(args.repoDir).toBe("/tmp/cwd-default");
  });

  test("a padded env var trims to its content", () => {
    const args = parseCleanupArgs(
      ["--dry-run"],
      {
        GH_APP_ID: "",
        GITHUB_REPO: "acme/widgets",
        ORI_INTERN_WORKSPACE_ROOT: "  /tmp/checkout-root  ",
      },
      "/tmp/cwd-default"
    );
    expect(args.repoDir).toBe("/tmp/checkout-root");
  });
});
