import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { STRAY_CLONE_DETAIL, cleanupWorktrees } from "./cleanup-worktrees-core.ts";

/**
 * Regression: the open-pr skill clones to `/tmp/worktrees/<slug>/<branch>`,
 * and a slash-bearing branch (`fix/topic`) nests that clone one level down.
 * The sweep lists only the slug dir's children, so it found the `fix`
 * container, which has no `.git` of its own, and reported THAT as the stray
 * with "run `git worktree prune`": the remedy the stray-clone fix retired,
 * at a path that is not the clone. A container holding only directories is
 * now descended, and each nested clone is named at its own path. A directory
 * that also holds files is not a namespace container and is still reported
 * as itself.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

const noFetch = (): Promise<Response> => Promise.reject(new Error("no PR lookup expected"));

describe("a standalone clone under a branch-namespace container is named as one", () => {
  test("fix/topic and a/b/c clones are reported at their own paths with the clone remedy", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wwg-stray-nested-")));
    try {
      const checkout = join(root, "checkout");
      mkdirSync(checkout);
      git(checkout, "init", "-q", "-b", "main");
      writeFileSync(join(checkout, "a.txt"), "one\n");
      git(checkout, "add", ".");
      git(checkout, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
      const slugDir = join(root, "worktrees", "owner-repo");
      const nested = join(slugDir, "fix", "topic");
      const deep = join(slugDir, "a", "b", "c");
      git(root, "clone", "-q", checkout, nested);
      git(root, "clone", "-q", checkout, deep);
      const mixed = join(slugDir, "notes");
      mkdirSync(join(mixed, "sub"), { recursive: true });
      writeFileSync(join(mixed, "readme.txt"), "x\n");
      writeFileSync(join(mixed, "sub", "f.txt"), "x\n");
      const summary = await Effect.runPromise(
        cleanupWorktrees(
          { fetchImpl: noFetch, token: "t" },
          {
            dryRun: true,
            repo: "owner/repo",
            repoDir: checkout,
            repoSlug: "owner-repo",
            worktreesRoot: join(root, "worktrees"),
          }
        )
      );
      const byPath = new Map(summary.outcomes.map((o) => [o.path, o]));
      expect(byPath.get(nested)?.decision).toBe("skipped-stray");
      expect(byPath.get(nested)?.detail).toBe(STRAY_CLONE_DETAIL);
      expect(byPath.get(deep)?.detail).toBe(STRAY_CLONE_DETAIL);
      expect(byPath.has(join(slugDir, "fix"))).toBe(false);
      expect(byPath.has(join(slugDir, "a"))).toBe(false);
      expect(byPath.get(mixed)?.decision).toBe("skipped-stray");
      expect(byPath.get(mixed)?.detail).toContain("run `git worktree prune`");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
