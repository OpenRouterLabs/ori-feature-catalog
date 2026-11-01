import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import type { FetchLike } from "./scripts/commit-api-core.ts";

import { commitViaApi } from "./scripts/commit-via-api.ts";

/**
 * Regression (the stale-base class): step 5 of the prompt's change flow
 * created the remote branch from `main` READ AGAIN at commit time
 * (`gh api repos/$REPO/git/ref/heads/main`), while the worktree was cut from
 * the `main` fetched back in step 1. Any merge to main in between (minutes to
 * hours of install / edit / test) put the branch on a NEWER base than the
 * worktree's. `commit-via-api.ts` builds the commit as the branch head's tree
 * plus the FULL content of every file the worktree changed — content edited
 * on the OLD base — so a file both sides touched came back with the other
 * merge's change silently reverted in the PR, and the post-commit local sync
 * (#340) refused the worktree ("left as-is") on every such run.
 *
 * The branch now starts at the worktree's own HEAD, so the remote parent is
 * exactly the tree the edits were made on: the PR shows only the edits, and a
 * real overlap with a newer main surfaces as a merge conflict, never a silent
 * revert.
 */

const prompt = readFileSync(join(import.meta.dir, "prompt.md"), "utf8");

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

const identity = ["-c", "user.email=t@example.com", "-c", "user.name=t"];

/** The Git Data API, faked around a real bare remote: the branch head is
 *  `parentSha` and every created blob's content is recorded. */
const fakeGitHub =
  (parentSha: string, blobs: string[]): FetchLike =>
  (url: string, init?: RequestInit) => {
    if (url.includes("/git/ref/heads/")) {
      return Promise.resolve(Response.json({ object: { sha: parentSha } }));
    }
    if (url.includes("/git/commits/")) {
      return Promise.resolve(Response.json({ tree: { sha: "t".repeat(40) } }));
    }
    if (url.endsWith("/git/blobs")) {
      const body = JSON.parse(String(init?.body)) as { content: string };
      blobs.push(Buffer.from(body.content, "base64").toString("utf8"));
      return Promise.resolve(Response.json({ sha: "b".repeat(40) }));
    }
    if (url.endsWith("/git/trees")) {
      return Promise.resolve(Response.json({ sha: "e".repeat(40) }));
    }
    if (url.endsWith("/git/commits")) {
      return Promise.resolve(Response.json({ sha: "c".repeat(40) }));
    }
    if (url.includes("/git/refs/heads/")) {
      return Promise.resolve(Response.json({ object: { sha: "c".repeat(40) } }));
    }
    return Promise.resolve(Response.json({}, { status: 500 }));
  };

describe("the change flow's remote branch starts at the worktree's base", () => {
  test("step 5 derives BASE_SHA from the worktree HEAD, never a fresh read of main", () => {
    const base = prompt
      .split("\n")
      .find((line) => line.trimStart().startsWith("BASE_SHA="));
    expect(base).toBeDefined();
    expect(base).toContain('git -C "$WT" rev-parse HEAD');
    expect(base).not.toContain("git/ref/heads/main");
  });

  test("a branch cut from a moved main carries the old-base file over the newer change", async () => {
    const root = mkdtempSync(join(tmpdir(), "wwg-branch-base-"));
    try {
      const remote = join(root, "remote.git");
      git(root, "init", "-q", "--bare", "-b", "main", remote);
      const seed = join(root, "seed");
      git(root, "clone", "-q", remote, seed);
      writeFileSync(join(seed, "x.txt"), "l1\nl2\n");
      git(seed, "add", ".");
      git(seed, ...identity, "commit", "-qm", "A");
      git(seed, "push", "-q", "origin", "HEAD:main");
      const shaA = git(seed, "rev-parse", "HEAD");

      // Step 1: the worktree is cut from main as fetched (A) and edited.
      const checkout = join(root, "checkout");
      git(root, "clone", "-q", remote, checkout);
      mkdirSync(join(root, "worktrees", "owner-repo"), { recursive: true });
      const worktree = join(root, "worktrees", "owner-repo", "fix-x");
      git(checkout, "worktree", "add", "-q", worktree, "-b", "fix-x", shaA);
      writeFileSync(join(worktree, "x.txt"), "l1-mine\nl2\n");

      // Meanwhile another PR merges to main (B), changing the same file.
      writeFileSync(join(seed, "x.txt"), "l1\nl2-theirs\n");
      git(seed, ...identity, "commit", "-qam", "B");
      git(seed, "push", "-q", "origin", "HEAD:main");
      const shaB = git(seed, "rev-parse", "HEAD");

      const run = async (parentSha: string) => {
        const blobs: string[] = [];
        const warnings: string[] = [];
        await Effect.runPromise(
          commitViaApi(
            { branch: "fix-x", message: "fix", repo: "owner/repo", worktree },
            {
              fetchImpl: fakeGitHub(parentSha, blobs),
              remoteUrl: () => join(root, "missing.git"),
              token: "not-a-real-token",
              warn: (text) => {
                warnings.push(text);
              },
            }
          )
        );
        return { blobs, warnings };
      };

      // Pre-fix recipe: the branch sits on B, and the commit puts the A-based
      // x.txt on top of it — B's `l2-theirs` is gone from the PR.
      const stale = await run(shaB);
      expect(stale.blobs).toEqual(["l1-mine\nl2\n"]);
      expect(stale.warnings.join("")).toContain("left as-is");

      // The fixed recipe: the branch sits on the worktree's own HEAD (A), so
      // the commit is exactly the edit on the tree it was made on.
      expect(git(worktree, "rev-parse", "HEAD")).toBe(shaA);
      const fresh = await run(git(worktree, "rev-parse", "HEAD"));
      expect(fresh.blobs).toEqual(["l1-mine\nl2\n"]);
      expect(fresh.warnings.join("")).not.toContain("left as-is");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
