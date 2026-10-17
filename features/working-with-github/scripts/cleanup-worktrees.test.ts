import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { GhAppError } from "@ori-monorepo/working-with-github/gh-app-token.ts";

import {
  formatOutcome,
  parseCleanupArgs,
  runCleanup,
} from "./cleanup-worktrees.ts";

interface Writers {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** Collect writes to the two output channels so assertions can inspect them. */
const makeWriters = (): {
  readonly out: string[];
  readonly err: string[];
  readonly writers: Writers;
} => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    err,
    out,
    writers: {
      err: (t: string): void => {
        err.push(t);
      },
      out: (t: string): void => {
        out.push(t);
      },
    },
  };
};

describe("parseCleanupArgs", () => {
  test("defaults: no flags, GITHUB_REPO from env, cwd as repoDir, default worktrees root, not dry-run", () => {
    expect(
      parseCleanupArgs([], { GITHUB_REPO: "owner/repo" }, "/repo/checkout")
    ).toEqual({
      dryRun: false,
      repo: "owner/repo",
      repoDir: "/repo/checkout",
      worktreesRoot: "/tmp/worktrees",
    });
  });

  test("--repo overrides GITHUB_REPO", () => {
    expect(
      parseCleanupArgs(
        ["--repo", "other/repo"],
        { GITHUB_REPO: "owner/repo" },
        "/repo/checkout"
      )
    ).toEqual({
      dryRun: false,
      repo: "other/repo",
      repoDir: "/repo/checkout",
      worktreesRoot: "/tmp/worktrees",
    });
  });

  test("--repo-dir, --worktrees-root, and --dry-run", () => {
    expect(
      parseCleanupArgs(
        [
          "--repo-dir",
          "/other/checkout",
          "--worktrees-root",
          "/tmp/custom",
          "--dry-run",
        ],
        { GITHUB_REPO: "owner/repo" },
        "/repo/checkout"
      )
    ).toEqual({
      dryRun: true,
      repo: "owner/repo",
      repoDir: "/other/checkout",
      worktreesRoot: "/tmp/custom",
    });
  });
});

describe("formatOutcome", () => {
  test("renders decision, path, and detail", () => {
    expect(
      formatOutcome({
        branch: "b",
        decision: "removed",
        detail: "removed (PR #1 closed, tree clean)",
        path: "/tmp/worktrees/x/b",
      })
    ).toBe("[removed] /tmp/worktrees/x/b — removed (PR #1 closed, tree clean)");
  });
});

describe("runCleanup", () => {
  test("fails with a clear stderr message when repo can't be resolved", async () => {
    const { err, out, writers } = makeWriters();
    const code = await Effect.runPromise(
      runCleanup(
        Effect.succeed({
          expiresAt: "",
          token: "tok",
        }),
        {
          dryRun: false,
          repo: "",
          repoDir: "/repo/checkout",
          worktreesRoot: "/tmp/worktrees",
        },
        writers
      )
    );
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err[0]).toContain("no --repo given");
  });

  test("writes a diagnostic to stderr and exits 1 on a mint failure", async () => {
    const { err, out, writers } = makeWriters();
    const failure = new GhAppError({
      message: "Bad credentials",
      op: "http",
      status: 401,
    });
    const code = await Effect.runPromise(
      runCleanup(
        Effect.fail(failure),
        {
          dryRun: false,
          repo: "owner/repo",
          repoDir: "/repo/checkout",
          worktreesRoot: "/tmp/worktrees",
        },
        writers
      )
    );
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err[0]).toContain("could not mint a token");
    expect(err[0]).toContain("Bad credentials");
  });

  test("reports nothing to do when the worktrees root holds no worktrees", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "wwg-worktrees-"));
    const { err, out, writers } = makeWriters();
    try {
      const code = await Effect.runPromise(
        runCleanup(
          Effect.succeed({ expiresAt: "", token: "tok" }),
          {
            dryRun: true,
            repo: "owner/repo",
            repoDir: root,
            worktreesRoot: join(root, "worktrees"),
          },
          writers
        )
      );
      expect(code).toBe(0);
      expect(err).toEqual([]);
      expect(out).toEqual(["cleanup-worktrees: nothing under the worktrees root.\n"]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
