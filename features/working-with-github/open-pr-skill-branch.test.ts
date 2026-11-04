import { describe, expect, test } from "bun:test";
// The skill's clone stayed on the default branch. commit-via-api.ts syncs the
// local branch only when the checkout has the PR's branch checked out, so the
// first round left the committed files listed as changed and the second round
// on the same branch (a CI fix, step 8) was refused for those files, with a
// `git merge FETCH_HEAD` remedy that failed on the same local changes.
import { readFileSync } from "node:fs";
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
