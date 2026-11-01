import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import type { FetchLike } from "./commit-api-core.ts";

import { cleanupWorktrees } from "./cleanup-worktrees-core.ts";
import { commitViaApi } from "./commit-via-api.ts";

/**
 * Regression (the dirty-after-commit class): `commit-via-api.ts` committed
 * through the Git Data API only and never touched the local worktree, so
 * every edit it had just committed stayed an UNCOMMITTED local modification.
 * The prompt's own last step, `git worktree remove "$WT"`, then refused the
 * worktree ("contains modified or untracked files, use --force"), and the
 * daily cleanup sweep reported it `skipped-dirty` even after its PR closed —
 * no worktree the documented flow made was ever removed.
 *
 * The flow now points the local branch at the pushed commit (fetch + mixed
 * reset) when the worktree is that branch at the remote parent, leaving the
 * worktree clean. These tests drive the real flow and real git against a local
 * bare repo standing in for GitHub; the API calls are faked, and the commit
 * the fake API "creates" is pushed to the bare repo by a second clone.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

const identity = ["-c", "user.email=t@example.com", "-c", "user.name=t"];

interface Fixture {
  readonly root: string;
  readonly remote: string;
  readonly checkout: string;
  readonly worktreesRoot: string;
  readonly worktree: string;
  readonly baseSha: string;
  readonly newSha: string;
}

/** A bare "GitHub", a checkout with a `fix-x` worktree carrying one edit, and
 *  the commit the API would create for that edit, already on the remote. */
const fixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "wwg-local-sync-"));
  const remote = join(root, "remote.git");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const seed = join(root, "seed");
  git(root, "clone", "-q", remote, seed);
  writeFileSync(join(seed, "a.txt"), "one\n");
  git(seed, "add", ".");
  git(seed, ...identity, "commit", "-qm", "base");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const baseSha = git(seed, "rev-parse", "HEAD");
  // The commit GitHub creates for the edit (its sha is whatever the API says).
  writeFileSync(join(seed, "a.txt"), "two\n");
  writeFileSync(join(seed, "b.txt"), "new\n");
  git(seed, "add", ".");
  git(seed, ...identity, "commit", "-qm", "fix");
  git(seed, "push", "-q", "origin", "HEAD:refs/heads/fix-x");
  const newSha = git(seed, "rev-parse", "HEAD");

  const checkout = join(root, "checkout");
  git(root, "clone", "-q", remote, checkout);
  const worktreesRoot = join(root, "worktrees");
  mkdirSync(join(worktreesRoot, "owner-repo"), { recursive: true });
  const worktree = join(worktreesRoot, "owner-repo", "fix-x");
  git(checkout, "worktree", "add", "-q", worktree, "-b", "fix-x", baseSha);
  writeFileSync(join(worktree, "a.txt"), "two\n");
  writeFileSync(join(worktree, "b.txt"), "new\n");
  return { root, remote, checkout, worktreesRoot, worktree, baseSha, newSha };
};

/** The Git Data API, faked: the branch head is `parentSha`, and the commit it
 *  creates is `newSha`. The PR lookup answers one closed PR. */
const fakeGitHub =
  (parentSha: string, newSha: string): FetchLike =>
  (url: string) => {
    if (url.includes("/pulls?")) {
      return Promise.resolve(Response.json([{ number: 7, state: "closed" }]));
    }
    if (url.includes("/git/ref/heads/")) {
      return Promise.resolve(Response.json({ object: { sha: parentSha } }));
    }
    if (url.includes("/git/commits/")) {
      return Promise.resolve(Response.json({ tree: { sha: "t".repeat(40) } }));
    }
    if (url.endsWith("/git/blobs")) {
      return Promise.resolve(Response.json({ sha: "b".repeat(40) }));
    }
    if (url.endsWith("/git/trees")) {
      return Promise.resolve(Response.json({ sha: "e".repeat(40) }));
    }
    if (url.endsWith("/git/commits")) {
      return Promise.resolve(Response.json({ sha: newSha }));
    }
    if (url.includes("/git/refs/heads/")) {
      return Promise.resolve(Response.json({ object: { sha: newSha } }));
    }
    return Promise.resolve(Response.json({}, { status: 500 }));
  };

const commit = (
  fx: Fixture,
  options: {
    readonly parentSha?: string;
    readonly worktree?: string;
    readonly remoteUrl?: string;
  } = {}
): Promise<{ readonly sha: string; readonly warnings: readonly string[] }> => {
  const warnings: string[] = [];
  return Effect.runPromise(
    commitViaApi(
      {
        branch: "fix-x",
        message: "fix",
        repo: "owner/repo",
        worktree: options.worktree ?? fx.worktree,
      },
      {
        fetchImpl: fakeGitHub(options.parentSha ?? fx.baseSha, fx.newSha),
        remoteUrl: () => options.remoteUrl ?? fx.remote,
        token: "not-a-real-token",
        warn: (text) => {
          warnings.push(text);
        },
      }
    )
  ).then((sha) => ({ sha, warnings }));
};

describe("commit-via-api leaves the worktree clean after a signed commit", () => {
  test("the local branch points at the pushed commit and git status is empty", async () => {
    const fx = fixture();
    try {
      const { sha, warnings } = await commit(fx);
      expect(sha).toBe(fx.newSha);
      expect(warnings).toEqual([]);
      expect(git(fx.worktree, "rev-parse", "HEAD")).toBe(fx.newSha);
      expect(git(fx.worktree, "status", "--porcelain")).toBe("");
    } finally {
      rmSync(fx.root, { force: true, recursive: true });
    }
  });

  test("the prompt's `git worktree remove \"$WT\"` then succeeds", async () => {
    const fx = fixture();
    try {
      await commit(fx);
      const removed = spawnSync("git", ["worktree", "remove", fx.worktree], {
        cwd: fx.checkout,
        encoding: "utf-8",
      });
      expect(removed.stderr).toBe("");
      expect(removed.status).toBe(0);
    } finally {
      rmSync(fx.root, { force: true, recursive: true });
    }
  });

  test("the cleanup sweep removes the worktree once its PR is closed", async () => {
    const fx = fixture();
    try {
      await commit(fx);
      const summary = await Effect.runPromise(
        cleanupWorktrees(
          { fetchImpl: fakeGitHub(fx.baseSha, fx.newSha), token: "t" },
          {
            dryRun: false,
            repo: "owner/repo",
            repoDir: fx.checkout,
            repoSlug: "owner-repo",
            worktreesRoot: fx.worktreesRoot,
          }
        )
      );
      expect(summary.outcomes.map((outcome) => outcome.decision)).toEqual([
        "removed",
      ]);
    } finally {
      rmSync(fx.root, { force: true, recursive: true });
    }
  });

  test("a branch that moved remotely is left alone, with a warning", async () => {
    const fx = fixture();
    try {
      const { sha, warnings } = await commit(fx, {
        parentSha: "f".repeat(40),
      });
      expect(sha).toBe(fx.newSha);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("left as-is");
      expect(git(fx.worktree, "rev-parse", "HEAD")).toBe(fx.baseSha);
      expect(git(fx.worktree, "status", "--porcelain")).not.toBe("");
    } finally {
      rmSync(fx.root, { force: true, recursive: true });
    }
  });

  test("a checkout on another branch never has that branch moved", async () => {
    const fx = fixture();
    try {
      // The main checkout sits on `main` at the same base commit; committing
      // its edits to `fix-x` must never reset `main` onto the new commit.
      writeFileSync(join(fx.checkout, "a.txt"), "two\n");
      writeFileSync(join(fx.checkout, "b.txt"), "new\n");
      const { warnings } = await commit(fx, { worktree: fx.checkout });
      expect(warnings.length).toBe(1);
      expect(git(fx.checkout, "rev-parse", "main")).toBe(fx.baseSha);
    } finally {
      rmSync(fx.root, { force: true, recursive: true });
    }
  });

  test("a failed fetch still returns the landed commit and names the failure", async () => {
    const fx = fixture();
    try {
      const { sha, warnings } = await commit(fx, {
        remoteUrl: join(fx.root, "missing.git"),
      });
      expect(sha).toBe(fx.newSha);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("git fetch failed");
      expect(warnings[0]).not.toContain("not-a-real-token");
      expect(git(fx.worktree, "rev-parse", "HEAD")).toBe(fx.baseSha);
    } finally {
      rmSync(fx.root, { force: true, recursive: true });
    }
  });
});
