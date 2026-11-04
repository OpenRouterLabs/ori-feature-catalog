import { describe, expect, test } from "bun:test";
// The skill's step 1 told the agent to commit with
// `commit-via-api.ts --worktree "$WT"` (plus `--as member` in ambient mode)
// and named no --repo. The script then falls back to $GITHUB_REPO, the
// workspace's own repository: unset in ambient mode, so the commit stopped
// with "missing required flag(s): --repo"; set to another repository, so
// every call went to a repository without the PR's branch.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const skill = readFileSync(join(import.meta.dir, "skills/open-pr/SKILL.md"), "utf8");
const stepOne = skill.slice(skill.indexOf("## 1."), skill.indexOf("## 2."));
const script = join(import.meta.dir, "scripts/commit-via-api.ts");

const commitCommand = (): string => {
  const match = /`(commit-via-api\.ts --worktree [^`]*)`/u.exec(stepOne);
  if (match?.[1] === undefined) throw new Error("step 1 names no commit-via-api.ts command");
  return match[1];
};

describe("open-pr step 1 commits to the cloned repository", () => {
  test("the commit command names --repo \"$REPO\", --branch and --message-file", () => {
    const command = commitCommand();
    expect(command).toContain('--repo "$REPO"');
    expect(command).toContain("--branch <branch>");
    expect(command).toContain("--message-file <file>");
  });

  test("run as written in ambient mode, with no GITHUB_REPO, the arguments parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "wwg-open-pr-commit-repo-"));
    try {
      const wt = join(dir, "wt");
      const msg = join(dir, "msg");
      writeFileSync(msg, "fix: x\n");
      Bun.spawnSync(["git", "init", "-q", wt]);
      const argv = commitCommand()
        .replace(/^commit-via-api\.ts /u, "")
        .replace('"$WT"', wt)
        .replace("<branch>", "fix-x")
        .replace("<file>", msg)
        .replace('"$REPO"', "acme/widgets")
        .split(" ");
      const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: dir };
      const proc = Bun.spawnSync(["bun", script, ...argv, "--as", "member"], {
        cwd: dir,
        env,
        stderr: "pipe",
        stdout: "pipe",
      });
      const stderr = proc.stderr.toString();
      expect(stderr).not.toContain("[args]");
      expect(stderr).toContain("[nothing-to-commit]");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
