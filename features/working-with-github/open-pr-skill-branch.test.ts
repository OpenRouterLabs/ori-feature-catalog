import { describe, expect, test } from "bun:test";
// The skill's clone stayed on the default branch. commit-via-api.ts syncs the
// local branch only when the checkout has the PR's branch checked out, so the
// first round left the committed files listed as changed and the second round
// on the same branch (a CI fix, step 8) was refused for those files, with a
// `git merge FETCH_HEAD` remedy that failed on the same local changes.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const skill = readFileSync(join(import.meta.dir, "skills/open-pr/SKILL.md"), "utf8");
const stepOne = skill.slice(skill.indexOf("## 1."), skill.indexOf("## 2."));
const recipe = stepOne.slice(stepOne.indexOf("```bash"), stepOne.indexOf("```\n\n"));

describe("open-pr step 1 puts the checkout on the PR's branch", () => {
  test("the recipe switches to the branch right after the clone, before any commit", () => {
    const clone = recipe.indexOf("git clone");
    const sw = recipe.indexOf("git switch -q -c <branch>");
    expect(clone).toBeGreaterThan(-1);
    expect(sw).toBeGreaterThan(clone);
  });

  test("an open PR is cloned at its head branch instead", () => {
    expect(stepOne).toContain("add `--branch <branch>` to the clone");
  });

  test("the remote branch is created at the clone's own HEAD", () => {
    expect(stepOne).toContain("create the branch on GitHub at the clone's own `HEAD` (`git rev-parse HEAD`");
  });

  test("the skill says why: commit-via-api syncs only the checked-out branch", () => {
    expect(stepOne).toContain("only when the checkout has that branch checked out");
  });
});

// git prints a non-ASCII path quoted, each byte an octal escape, unless
// core.quotePath is off. javascript-tutorial/ko.javascript.info's
// `.github/ISSUE_TEMPLATE/개선제안.md` listed as
// `".github/ISSUE_TEMPLATE/\352\260\234…md"`, so step 1's `ls-tree | grep` for
// a word of the name found nothing, and step 3's package-skill listing
// (anchored on `SKILL\.md$`) never matched the quoted path.
describe("open-pr steps 1 and 3 list non-ASCII paths as they are", () => {
  const stepThree = skill.slice(skill.indexOf("## 3."), skill.indexOf("## 4."));
  const listing = /```bash\n([\s\S]*?)```/u.exec(stepThree)?.[1] ?? "";

  test("step 1 and step 3 find a file and a package skill with non-ASCII names", () => {
    const root = mkdtempSync(join(tmpdir(), "wwg-quotepath-"));
    try {
      const src = join(root, "src");
      for (const [path, body] of [
        [".github/ISSUE_TEMPLATE/개선제안.md", "---\nname: x\n---\n"],
        ["pkg/.agents/skills/검토/SKILL.md", "---\nname: review\ndescription: review the package\n---\n"],
        ["pkg/src/a.ts", "export const a = 1;\n"],
      ] as const) {
        mkdirSync(join(src, path, ".."), { recursive: true });
        writeFileSync(join(src, path), body);
      }
      const git = (args: string[], cwd: string) => Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
      git(["init", "-q", "-b", "main"], src);
      git(["config", "uploadpack.allowFilter", "true"], src);
      git(["add", "-A"], src);
      git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], src);
      const fill = (text: string) =>
        text
          .replace("WT=/tmp/worktrees/${REPO//\\//-}/<branch>", `WT=${join(root, "wt")}`)
          .replace('"https://github.com/$REPO.git"', `"file://${src}"`)
          .replaceAll("<branch>", "fix-x")
          .replaceAll("<words from the task>", "개선")
          .replaceAll("<dirs the change touches>", "pkg/src")
          .replaceAll("<symbol>", "a")
          .replaceAll("<dir>", "pkg");
      const run = (script: string) =>
        Bun.spawnSync(["bash", "-c", script], { cwd: root, env: { ...process.env, WT: join(root, "wt") }, stderr: "pipe", stdout: "pipe" }).stdout.toString();
      expect(run(fill(recipe.replace(/^```bash\n/u, "")))).toContain(".github/ISSUE_TEMPLATE/개선제안.md");
      expect(run(fill(listing))).toContain("pkg/.agents/skills/검토/SKILL.md: review the package");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
