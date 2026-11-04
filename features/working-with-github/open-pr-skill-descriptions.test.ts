import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression: the open-pr skill's step 3 listed each repo skill's description
// with `grep -m1 '^description:'`, which prints only `description: >` for a
// description written as a YAML block. The block form is common: this skill
// uses it, and so do the create-pr, yeet and working-with-rfcs skills of the
// repository interns open most PRs against. The listing then showed `>` for
// exactly the PR skill the step exists to find.

const skill = readFileSync(join(import.meta.dir, "skills/open-pr/SKILL.md"), "utf8");

const stepThreeScript = (): string => {
  const section = skill.slice(skill.indexOf("## 3."), skill.indexOf("## 4."));
  const match = /```bash\n([\s\S]*?)\n```/u.exec(section);
  if (match?.[1] === undefined) throw new Error("step 3 has no bash block");
  return match[1];
};

const writeSkill = (root: string, name: string, frontmatter: string) => {
  mkdirSync(join(root, ".agents/skills", name), { recursive: true });
  writeFileSync(join(root, ".agents/skills", name, "SKILL.md"), `---\nname: ${name}\n${frontmatter}---\n\n# ${name}\n`);
};

describe("open-pr step 3 lists every skill's description", () => {
  test("block, literal and one-line descriptions all print their text", () => {
    const wt = mkdtempSync(join(tmpdir(), "wwg-open-pr-desc-"));
    try {
      writeSkill(wt, "folded", "description: >\n  Open a pull request\n  in the CI format.\nlicense: x\n");
      writeSkill(wt, "stripped", "description: >-\n  Write an RFC.\n");
      writeSkill(wt, "literal", "description: |\n  Ship a release.\n");
      writeSkill(wt, "inline", "description: Review a diff.\n");
      mkdirSync(join(wt, ".agents/skills/self"));
      writeFileSync(join(wt, ".agents/skills/self/SKILL.md"), skill);
      const proc = Bun.spawnSync(["bash", "-c", stepThreeScript()], {
        env: { ...process.env, WT: wt },
        stderr: "pipe",
        stdout: "pipe",
      });
      const out = proc.stdout.toString();
      expect(out).toContain("folded/SKILL.md: Open a pull request in the CI format.\n");
      expect(out).toContain("stripped/SKILL.md: Write an RFC.\n");
      expect(out).toContain("literal/SKILL.md: Ship a release.\n");
      expect(out).toContain("inline/SKILL.md: Review a diff.\n");
      expect(out).toContain("self/SKILL.md: Get a pull request ready the way the target repository expects");
      expect(out).not.toMatch(/: [>|]-?\n/u);
    } finally {
      rmSync(wt, { force: true, recursive: true });
    }
  });
});
