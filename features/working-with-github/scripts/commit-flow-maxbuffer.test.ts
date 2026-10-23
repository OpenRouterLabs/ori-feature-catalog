import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { defaultRunGit } from "./commit-api-core.ts";
import { parseStatusZ } from "./commit-api-core.ts";
import { commitViaApi } from "./commit-flow.ts";

// A worktree with more changed paths than `git status --porcelain=v1 -z`
// output bytes than spawnSync's DEFAULT 1MB maxBuffer can hold.
//
// Pre-fix, `defaultRunGit` passed no `maxBuffer`, so the default 1MB applied:
// the child was killed mid-stream with ENOBUFS, stdout was silently truncated
// mid-record, `ok` was false, and stderr was EMPTY — the commit flow then died
// with a blank `git status failed: ` diagnostic while every parsed record up
// to the truncation point was silently dropped (a partial change set would
// have been committed if the caller had ignored the error).
//
// ~5,200 untracked files with 190-char names produce >1MB of porcelain-z
// output in under half a second, so this stays a fast test.

/** A name near the filesystem limit, so few files are needed. */
const LONG_NAME = "n".repeat(190);

interface BigStatusResult {
  readonly fileCount: number;
  readonly porcelainBytes: number;
  readonly parsedCount: number;
}

/** Build a repo with `dirs × filesPerDir` untracked files, all long-named. */
const buildBigRepo = async (
  dir: string,
  dirs: number,
  filesPerDir: number
): Promise<BigStatusResult> => {
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "root"], {
    cwd: dir,
  });
  // Write the files without shelling out per file.
  const fileNames: string[] = [];
  for (let d = 1; d <= dirs; d += 1) {
    for (let i = 1; i <= filesPerDir; i += 1) {
      const name = `${LONG_NAME}-${d}-${i}.txt`;
      fileNames.push(name);
      await Bun.write(join(dir, name), "x");
    }
  }
  const status = defaultRunGit(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    dir
  );
  const { changed } = parseStatusZ(status.stdout);
  return {
    fileCount: fileNames.length,
    parsedCount: changed.length,
    porcelainBytes: status.stdout.length,
  };
};

describe("commit-via-api — git output larger than spawnSync's 1MB default", () => {
  test("defaultRunGit reads a >1MB status without truncating or losing records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wwg-maxbuffer-"));
    try {
      // 52 dirs × 100 files × ~203-byte records ≈ 1.06MB of porcelain-z.
      const result = await buildBigRepo(dir, 52, 100);
      expect(result.porcelainBytes).toBeGreaterThan(1024 * 1024);
      // Pre-fix: ok=false (ENOBUFS), truncated stdout, empty stderr.
      const status = defaultRunGit(
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        dir
      );
      expect(status.ok).toBeTrue();
      expect(status.stderr.trim()).toBe("");
      const { changed } = parseStatusZ(status.stdout);
      expect(changed.length).toBe(result.fileCount);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a git failure surfaces the spawn error, so `git status failed:` is never blank", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wwg-maxbuffer-err-"));
    try {
      // Not a git repo: `git status` fails with git's own message — the
      // baseline for the spawn-error path. The ENOBUFS path is exercised by
      // the >1MB test above (pre-fix it produced an empty stderr).
      const result = defaultRunGit(
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        dir
      );
      expect(result.ok).toBeFalse();
      expect(result.stderr.trim()).not.toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
