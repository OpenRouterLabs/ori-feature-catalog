import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import type { FetchLike } from "./commit-api-core.ts";

import { commitViaApi } from "./commit-via-api.ts";

/**
 * Regression: since #365 the flow commits a round when the branch moved
 * remotely but only AHEAD and only on other paths ("Update branch", a bot's
 * merge commit). The local sync still required the worktree HEAD to be the
 * remote parent, so it skipped exactly that round: the worktree kept listing
 * the committed files as modified, the next round was refused (those files
 * now differ remotely from the worktree HEAD), and the recovery the refusal
 * names, `git merge FETCH_HEAD`, fails with "Your local changes ... would be
 * overwritten by merge". `git worktree remove` and the cleanup sweep refused
 * the worktree too. The sync now brings the worktree to the new commit in
 * that case: the remote's paths from the commit, the committed ones as they
 * are on disk.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

const identity = ["-c", "user.email=t@example.com", "-c", "user.name=t"];

interface Fixture {
  readonly root: string;
  readonly remote: string;
  readonly checkout: string;
  readonly worktree: string;
  readonly seed: string;
  readonly baseSha: string;
  readonly movedSha: string;
}

/** A bare "GitHub" whose `fix-x` moved ahead of the worktree on `c.txt`
 *  (changed), `d.txt` (added) and `gone.txt` (deleted), and a worktree at the
 *  old base carrying edits to `a.txt` and a new `b.txt`. */
const fixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "wwg-moved-ahead-"));
  const remote = join(root, "remote.git");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const seed = join(root, "seed");
  git(root, "clone", "-q", remote, seed);
  writeFileSync(join(seed, "a.txt"), "one\n");
  writeFileSync(join(seed, "c.txt"), "old\n");
  writeFileSync(join(seed, "gone.txt"), "bye\n");
  git(seed, "add", ".");
  git(seed, ...identity, "commit", "-qm", "base");
  git(seed, "push", "-q", "origin", "HEAD:main", "HEAD:refs/heads/fix-x");
  const baseSha = git(seed, "rev-parse", "HEAD");
  writeFileSync(join(seed, "c.txt"), "updated remotely\n");
  writeFileSync(join(seed, "d.txt"), "added remotely\n");
  git(seed, "rm", "-q", "gone.txt");
  git(seed, "add", ".");
  git(seed, ...identity, "commit", "-qm", "update branch");
  git(seed, "push", "-q", "origin", "HEAD:refs/heads/fix-x");
  const movedSha = git(seed, "rev-parse", "HEAD");

  const checkout = join(root, "checkout");
  git(root, "clone", "-q", remote, checkout);
  mkdirSync(join(root, "worktrees"), { recursive: true });
  const worktree = join(root, "worktrees", "fix-x");
  git(checkout, "worktree", "add", "-q", worktree, "-b", "fix-x", baseSha);
  writeFileSync(join(worktree, "a.txt"), "two\n");
  writeFileSync(join(worktree, "b.txt"), "new\n");
  return { root, remote, checkout, worktree, seed, baseSha, movedSha };
};

/** Push the commit GitHub would create for the worktree's current edits on
 *  top of the remote head, and return its sha. */
const landOnRemote = (fx: Fixture, files: Record<string, string>): string => {
  git(fx.seed, "pull", "-q", "origin", "fix-x");
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(fx.seed, path), content);
  }
  git(fx.seed, "add", ".");
  git(fx.seed, ...identity, "commit", "-qm", "round");
  git(fx.seed, "push", "-q", "origin", "HEAD:refs/heads/fix-x");
  return git(fx.seed, "rev-parse", "HEAD");
};

/** The Git Data API, faked over the bare repo: the ref read answers the bare
 *  repo's real `fix-x`, the compare answers the bare repo's real diff, and the
 *  created commit is `created`. */
const fakeGitHub =
  (fx: Fixture, created: string, calls: string[]): FetchLike =>
  (url: string) => {
    calls.push(url);
    const compare = /\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/u.exec(url);
    if (compare !== null) {
      const [, base = "", head = ""] = compare;
      const ahead = spawnSync("git", ["merge-base", "--is-ancestor", base, head], {
        cwd: fx.remote,
      }).status === 0;
      const names = git(fx.remote, "diff", "--name-only", base, head)
        .split("\n")
        .filter((name) => name !== "");
      return Promise.resolve(
        Response.json({
          status: ahead ? "ahead" : "diverged",
          files: names.map((filename) => ({ filename })),
        })
      );
    }
    if (url.includes("/git/ref/heads/")) {
      return Promise.resolve(
        Response.json({ object: { sha: git(fx.remote, "rev-parse", "fix-x~1") } })
      );
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
      return Promise.resolve(Response.json({ sha: created }));
    }
    if (url.includes("/git/refs/heads/")) {
      return Promise.resolve(Response.json({ object: { sha: created } }));
    }
    return Promise.resolve(Response.json({}, { status: 500 }));
  };

const round = (
  fx: Fixture,
  created: string
): Promise<{ readonly sha: string; readonly warnings: readonly string[] }> => {
  const warnings: string[] = [];
  const calls: string[] = [];
  return Effect.runPromise(
    commitViaApi(
      { branch: "fix-x", message: "fix", repo: "owner/repo", worktree: fx.worktree },
      {
        fetchImpl: fakeGitHub(fx, created, calls),
        remoteUrl: () => fx.remote,
        token: "not-a-real-token",
        warn: (text) => {
          warnings.push(text);
        },
      }
    )
  ).then((sha) => ({ sha, warnings }));
};

describe("a round on a branch that moved ahead leaves the worktree synced", () => {
  test("the worktree is the new commit, clean, with the remote's changes on disk", async () => {
    const fx = fixture();
    try {
      const created = landOnRemote(fx, { "a.txt": "two\n", "b.txt": "new\n" });
      const { sha, warnings } = await round(fx, created);
      expect(sha).toBe(created);
      expect(warnings).toEqual([]);
      expect(git(fx.worktree, "rev-parse", "HEAD")).toBe(created);
      expect(git(fx.worktree, "status", "--porcelain")).toBe("");
      expect(readFileSync(join(fx.worktree, "c.txt"), "utf-8")).toBe("updated remotely\n");
      expect(readFileSync(join(fx.worktree, "d.txt"), "utf-8")).toBe("added remotely\n");
      expect(existsSync(join(fx.worktree, "gone.txt"))).toBe(false);
      expect(readFileSync(join(fx.worktree, "a.txt"), "utf-8")).toBe("two\n");
    } finally {
      rmSync(fx.root, { force: true, recursive: true });
    }
  });

  test("the next round on the same branch lands instead of being refused", async () => {
    const fx = fixture();
    try {
      const first = landOnRemote(fx, { "a.txt": "two\n", "b.txt": "new\n" });
      await round(fx, first);
      writeFileSync(join(fx.worktree, "a.txt"), "three\n");
      const second = landOnRemote(fx, { "a.txt": "three\n" });
      const { sha } = await round(fx, second);
      expect(sha).toBe(second);
      expect(git(fx.worktree, "status", "--porcelain")).toBe("");
    } finally {
      rmSync(fx.root, { force: true, recursive: true });
    }
  });

  test("the prompt's `git worktree remove \"$WT\"` then succeeds", async () => {
    const fx = fixture();
    try {
      const created = landOnRemote(fx, { "a.txt": "two\n", "b.txt": "new\n" });
      await round(fx, created);
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

  test("a move that changed a submodule is left as-is, so no round reverts it", async () => {
    const fx = fixture();
    try {
      git(fx.seed, "pull", "-q", "origin", "fix-x");
      git(fx.seed, "update-index", "--add", "--cacheinfo", `160000,${fx.baseSha},sub`);
      git(fx.seed, ...identity, "commit", "-qm", "bump submodule");
      git(fx.seed, "push", "-q", "origin", "HEAD:refs/heads/fix-x");
      const created = landOnRemote(fx, { "a.txt": "two\n", "b.txt": "new\n" });
      const { sha, warnings } = await round(fx, created);
      expect(sha).toBe(created);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("left as-is");
      expect(git(fx.worktree, "rev-parse", "HEAD")).toBe(fx.baseSha);
    } finally {
      rmSync(fx.root, { force: true, recursive: true });
    }
  });
});
