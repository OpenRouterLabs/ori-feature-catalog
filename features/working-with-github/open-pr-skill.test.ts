import { describe, expect, test } from "bun:test";
// Interns opened PRs that failed CI and ignored the repository's PR template:
// nothing sent them to the target repo's own rules, and their API commits skip
// its git hooks. The prompt must route every PR through the open-pr skill, and
// the skill must keep the steps that close those gaps.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");
const prompt = read("prompt.md");
const skill = read("skills/open-pr/SKILL.md");

describe("open-pr skill", () => {
  test("the frontmatter names the skill and says when to trigger it", () => {
    expect(skill).toMatch(/^---\nname: open-pr\ndescription: >\n {2}.*TRIGGER before opening any pull request in any repository/u);
  });

  test("the prompt sends every PR, in any repository, through the skill", () => {
    expect(prompt).toContain("Before you open or push to a pull request in any repository, load the `open-pr` skill");
    expect(prompt).toMatch(/4\. \*\*Test and lint\*\*.*`open-pr` skill/u);
    expect(prompt).toMatch(/6\. \*\*Open a PR\*\*.*`open-pr` skill/u);
  });

  test("the skill keeps the steps that close the gaps", () => {
    for (const needle of [
      "AGENTS.md",
      "PULL_REQUEST_TEMPLATE",
      ".github/workflows",
      ".agents/skills",
      "never runs lefthook",
      "Never write that a check passed unless you ran it",
      "Fill every section",
      "until every required check passes",
      "the tests related to the change",
      "never runs lefthook, husky, pre-commit or any other git hook",
      "--filter=blob:none --sparse",
      "--skip-checks",
      "Open it ready for review unless the repository's rules ask for drafts",
      "whether **CI skips draft PRs**",
      "Never `sleep` waiting on CI",
      "continueThisConversation",
    ]) expect(skill).toContain(needle);
  });

  test("the skill stays generic: no company, repo or ticket prefix of its own", () => {
    expect(skill).not.toMatch(/openrouter|ORI-<n>|HIPAA/iu);
  });
});
