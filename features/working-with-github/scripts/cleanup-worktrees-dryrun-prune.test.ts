import { afterEach, describe, expect, test } from "bun:test";

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { cleanupWorktrees, parseWorktreeList } from "./cleanup-worktrees-core.ts";

// `--dry-run` promises every decision "without removing anything", but the
// sweep ran a bare `git worktree prune` first in a dry run too. That deletes
// the admin entry (.git/worktrees/<name>) of EVERY worktree whose directory is
// gone, repo-wide and far outside the slug the sweep is scoped to, and the
// dry-run report never mentioned it.

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

const git = (cwd: string, ...args: string[]): string => {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd, stderr: "pipe", stdout: "pipe" }
  );
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
};

const repoWithVanishedWorktree = () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "wwg-dryrun-prune-")));
  scratch.push(work);
  const repo = join(work, "repo");
  const root = join(work, "worktrees");
  mkdirSync(repo);
  mkdirSync(join(root, "acme-widgets"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const elsewhere = join(work, "elsewhere", "gone-elsewhere");
  git(repo, "worktree", "add", "-q", join(root, "acme-widgets", "gone"), "-b", "gone");
  git(repo, "worktree", "add", "-q", elsewhere, "-b", "gone-elsewhere");
  rmSync(join(root, "acme-widgets", "gone"), { force: true, recursive: true });
  rmSync(elsewhere, { force: true, recursive: true });
  return { repo, root };
};

const sweep = (repo: string, root: string, dryRun: boolean) =>
  Effect.runPromise(
    cleanupWorktrees(
      { fetchImpl: () => Promise.resolve(Response.json([])) },
      {
        dryRun,
        repo: "acme/widgets",
        repoDir: repo,
        repoSlug: "acme-widgets",
        worktreesRoot: root,
      }
    )
  );

describe("cleanup-worktrees --dry-run prunes nothing", () => {
  test("a vanished worktree's admin entry survives a dry run", async () => {
    const { repo, root } = repoWithVanishedWorktree();
    const summary = await sweep(repo, root, true);
    expect(existsSync(join(repo, ".git", "worktrees", "gone"))).toBe(true);
    expect(existsSync(join(repo, ".git", "worktrees", "gone-elsewhere"))).toBe(true);
    expect(git(repo, "worktree", "list", "--porcelain")).toContain("prunable");
    expect(summary.outcomes).toEqual([]);
  });

  test("the real sweep still prunes, and reports the same as the dry run", async () => {
    const { repo, root } = repoWithVanishedWorktree();
    const dry = await sweep(repo, root, true);
    const real = await sweep(repo, root, false);
    expect(existsSync(join(repo, ".git", "worktrees", "gone"))).toBe(false);
    expect(real.outcomes).toEqual(dry.outcomes);
  });

  test("parseWorktreeList marks a prunable block", () => {
    expect(
      parseWorktreeList(
        "worktree /tmp/w/a\nHEAD abc\nbranch refs/heads/a\nprunable gitdir file points to non-existent location\n\nworktree /tmp/w/b\nHEAD abc\nbranch refs/heads/b\n"
      )
    ).toEqual([
      { branch: "a", path: "/tmp/w/a", prunable: true },
      { branch: "b", path: "/tmp/w/b" },
    ]);
  });
});
