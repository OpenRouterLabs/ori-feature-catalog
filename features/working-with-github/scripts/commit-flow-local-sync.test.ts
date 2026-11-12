import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import type { FetchLike, RunGit } from "./commit-api-core.ts";

import { cleanupWorktrees } from "./cleanup-worktrees-core.ts";
import { defaultRunGit } from "./commit-api-core.ts";
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
 *  creates is `newSha`. The PR lookup answers one closed PR, and a compare
 *  answers `compare` (the remote moved ahead, touching `c.txt` only). */
const fakeGitHub =
  (
    parentSha: string,
    newSha: string,
    compare: unknown = { status: "ahead", files: [{ filename: "c.txt" }] },
    calls: string[] = []
  ): FetchLike =>
  (url: string) => {
    calls.push(url);
    if (url.includes("/compare/")) {
      return compare === null
        ? Promise.resolve(Response.json({ message: "Not Found" }, { status: 404 }))
        : Promise.resolve(Response.json(compare));
    }
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
    readonly compare?: unknown;
    readonly calls?: string[];
    readonly runGit?: RunGit;
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
        fetchImpl: fakeGitHub(
          options.parentSha ?? fx.baseSha,
          fx.newSha,
          options.compare,
          options.calls
        ),
        remoteUrl: () => options.remoteUrl ?? fx.remote,
        ...(options.runGit === undefined ? {} : { runGit: options.runGit }),
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
      expect(warnings[0]).toContain("does not appear to be a git repository");
      expect(warnings[0]).not.toContain("not-a-real-token");
      expect(git(fx.worktree, "rev-parse", "HEAD")).toBe(fx.baseSha);
    } finally {
      rmSync(fx.root, { force: true, recursive: true });
    }
  });

  // Live: GitHub answers a git fetch with HTTP 429 under load. Pre-fix the
  // warning said only "git fetch failed", hiding the rate limit, and named no
  // way to finish the sync, so the worktree stayed dirty.
  test("a rate-limited fetch names the 429 and the command that finishes the sync", async () => {
    const fx = fixture();
    // Its own process: the flow's git calls are synchronous and would block
    // a server running on this test's event loop.
    const server = Bun.spawn(
      [
        process.execPath,
        "-e",
        'const s = Bun.serve({ port: 0, fetch: () => new Response("rate limited", { status: 429 }) }); console.log(s.port);',
      ],
      { stdout: "pipe" }
    );
    try {
      const reader = server.stdout.getReader();
      const { value } = await reader.read();
      reader.releaseLock();
      const port = new TextDecoder().decode(value).trim();
      const { sha, warnings } = await commit(fx, {
        remoteUrl: `http://x-access-token:not-a-real-token@127.0.0.1:${port}/owner/repo.git`,
      });
      expect(sha).toBe(fx.newSha);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("git fetch failed");
      expect(warnings[0]).toContain("429");
      expect(warnings[0]).not.toContain("not-a-real-token");
      expect(warnings[0]).toContain(
        `git fetch "https://x-access-token:\${TOKEN}@github.com/owner/repo.git" refs/heads/fix-x && git reset --mixed ${fx.newSha}`
      );
      // The named command, run once the fetch works, leaves the worktree clean.
      git(fx.worktree, "fetch", "-q", fx.remote, "refs/heads/fix-x");
      git(fx.worktree, "reset", "-q", "--mixed", fx.newSha);
      expect(git(fx.worktree, "status", "--porcelain")).toBe("");
    } finally {
      server.kill();
      rmSync(fx.root, { force: true, recursive: true });
    }
  });
});

// A fetch whose server accepts the connection and never answers held the
// whole run: the commit had landed, but commit-via-api never returned (killed
// by a 200s cap in the repro). Git now gives up below 1 KB/s for a minute.
describe("the post-commit fetch cannot hang the run", () => {
  const stalledServer = async (): Promise<{ readonly port: string; readonly kill: () => void }> => {
    // Its own process, like the 429 server above, and one that never writes.
    const server = Bun.spawn(
      [
        process.execPath,
        "-e",
        'const s = require("node:net").createServer((c) => { c.on("data", () => {}); }); s.listen(0, "127.0.0.1", () => console.log(s.address().port));',
      ],
      { stdout: "pipe" }
    );
    const reader = server.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    return { port: new TextDecoder().decode(value).trim(), kill: () => server.kill() };
  };

  test("the fetch carries git's low-speed limit", async () => {
    const fx = fixture();
    const fetches: string[][] = [];
    try {
      await commit(fx, {
        runGit: (args, cwd) => {
          if (args.includes("fetch")) fetches.push([...args]);
          return defaultRunGit(args, cwd);
        },
      });
      expect(fetches.length).toBe(1);
      expect(fetches[0]?.slice(0, 5)).toEqual([
        "-c",
        "http.lowSpeedLimit=1024",
        "-c",
        "http.lowSpeedTime=60",
        "fetch",
      ]);
    } finally {
      rmSync(fx.root, { force: true, recursive: true });
    }
  });

  test("a server that never answers ends in a warning, and the landed commit is returned", async () => {
    const fx = fixture();
    const server = await stalledServer();
    try {
      const started = Date.now();
      const { sha, warnings } = await commit(fx, {
        remoteUrl: `http://127.0.0.1:${server.port}/owner/repo.git`,
        // The real limit with a 2s window, so the test does not wait a minute.
        runGit: (args, cwd) =>
          defaultRunGit(
            args.map((arg) => (arg === "http.lowSpeedTime=60" ? "http.lowSpeedTime=2" : arg)),
            cwd
          ),
      });
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(sha).toBe(fx.newSha);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("git fetch failed");
      expect(warnings[0]).toContain("too slow");
    } finally {
      server.kill();
      rmSync(fx.root, { force: true, recursive: true });
    }
  }, 30_000);
});

/**
 * Regression (#365): the worktree's `git status` lists changes against its
 * own HEAD, and each changed file is sent WHOLE on top of the remote head's
 * tree. When the branch moved remotely and changed a file this round also
 * commits, the commit replaced that file with the worktree's copy and
 * silently reverted the push. The flow now asks GitHub how the two heads
 * relate before any blob is created, and refuses the round when a committed
 * path was changed remotely, when the worktree holds commits the branch
 * lacks, or when the comparison cannot be read.
 */
describe("commit-via-api never reverts a moved branch's changes (#365)", () => {
  const refused = async (
    fx: Fixture,
    compare: unknown
  ): Promise<{ readonly message: string; readonly calls: string[] }> => {
    const calls: string[] = [];
    const message = await commit(fx, {
      parentSha: "f".repeat(40),
      compare,
      calls,
    }).then(
      () => "landed",
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
    return { message, calls };
  };

  test("a remote change to a file this round commits refuses before any blob", async () => {
    const fx = fixture();
    try {
      const { message, calls } = await refused(fx, {
        status: "ahead",
        files: [{ filename: "a.txt" }],
      });
      expect(message).toContain("a.txt");
      expect(message).toContain("git merge FETCH_HEAD");
      expect(calls.some((url) => url.endsWith("/git/blobs"))).toBe(false);
      expect(calls.some((url) => url.includes("/git/refs/heads/"))).toBe(false);
      expect(git(fx.worktree, "rev-parse", "HEAD")).toBe(fx.baseSha);
    } finally {
      rmSync(fx.root, { force: true, recursive: true });
    }
  });

  test("a remote rename away from a committed path refuses too", async () => {
    const fx = fixture();
    try {
      const { message } = await refused(fx, {
        status: "ahead",
        files: [{ filename: "moved.txt", previous_filename: "b.txt" }],
      });
      expect(message).toContain("b.txt");
    } finally {
      rmSync(fx.root, { force: true, recursive: true });
    }
  });

  test("a worktree holding commits the branch lacks refuses", async () => {
    const fx = fixture();
    try {
      const { message } = await refused(fx, { status: "diverged", files: [] });
      expect(message).toContain("diverged");
    } finally {
      rmSync(fx.root, { force: true, recursive: true });
    }
  });

  test("a comparison GitHub cannot answer refuses instead of guessing", async () => {
    const fx = fixture();
    try {
      const { message, calls } = await refused(fx, null);
      expect(message).toContain("could not compare");
      expect(message).not.toContain("not-a-real-token");
      expect(calls.some((url) => url.endsWith("/git/commits"))).toBe(false);
    } finally {
      rmSync(fx.root, { force: true, recursive: true });
    }
  });

  test("a worktree at the remote head never asks for a comparison", async () => {
    const fx = fixture();
    try {
      const calls: string[] = [];
      await commit(fx, { calls });
      expect(calls.some((url) => url.includes("/compare/"))).toBe(false);
    } finally {
      rmSync(fx.root, { force: true, recursive: true });
    }
  });
});
