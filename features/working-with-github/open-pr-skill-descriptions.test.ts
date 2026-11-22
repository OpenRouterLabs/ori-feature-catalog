import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

// Step 3 reads skills from the index, so a fixture is committed first.
const commitAll = (wt: string) => {
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]]) {
    const proc = Bun.spawnSync(["git", ...args], { cwd: wt, stderr: "pipe", stdout: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  }
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
      commitAll(wt);
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

  test("a long description keeps 200 characters, never a split one", () => {
    // `cut -c1-200` counts bytes: a Chinese description kept 66 characters and
    // ended in two bytes of a third, invalid UTF-8 in the listing.
    const wt = mkdtempSync(join(tmpdir(), "wwg-open-pr-desc-"));
    try {
      writeSkill(wt, "cjk", `description: ${"漢".repeat(250)}\n`);
      writeSkill(wt, "emoji", `description: >\n  ${"🚀".repeat(250)}\n`);
      writeSkill(wt, "ascii", `description: ${"a".repeat(250)}\n`);
      commitAll(wt);
      const proc = Bun.spawnSync(["bash", "-c", stepThreeScript()], {
        env: { ...process.env, WT: wt },
        stderr: "pipe",
        stdout: "pipe",
      });
      const out = new TextDecoder("utf-8", { fatal: true }).decode(proc.stdout);
      expect(out).toContain(`cjk/SKILL.md: ${"漢".repeat(200)}\n`);
      expect(out).toContain(`emoji/SKILL.md: ${"🚀".repeat(200)}\n`);
      expect(out).toContain(`ascii/SKILL.md: ${"a".repeat(200)}\n`);
    } finally {
      rmSync(wt, { force: true, recursive: true });
    }
  });

  test("a Windows-line-ending block and a plain multi-line description print their text", () => {
    // A SKILL.md saved with CRLF endings left "\r" after the block marker, so
    // the marker test failed and the listing printed ">" plus a carriage return;
    // a bare "description:" with plain text on the indented lines below printed
    // nothing at all.
    const wt = mkdtempSync(join(tmpdir(), "wwg-open-pr-desc-"));
    try {
      writeSkill(wt, "crlf", "description: >\r\n  Ship it\r\n  from Windows.\r\nlicense: x\r\n");
      writeSkill(wt, "crlfinline", "description: Review a diff.\r\n");
      writeSkill(wt, "plain", "description:\n  Plain text\n  on two lines.\nlicense: x\n");
      commitAll(wt);
      const proc = Bun.spawnSync(["bash", "-c", stepThreeScript()], {
        env: { ...process.env, WT: wt },
        stderr: "pipe",
        stdout: "pipe",
      });
      const out = proc.stdout.toString();
      expect(out).toContain("crlf/SKILL.md: Ship it from Windows.\n");
      expect(out).toContain("crlfinline/SKILL.md: Review a diff.\n");
      expect(out).toContain("plain/SKILL.md: Plain text on two lines.\n");
      expect(out).not.toContain("\r");
    } finally {
      rmSync(wt, { force: true, recursive: true });
    }
  });
});

// Regression: step 3 listed only the root `.agents/skills`, `.claude/skills`
// and `.cursor/rules`. A monorepo package can keep skills beside its own code
// (`apps/desktop/.agents/skills/<name>/SKILL.md`) that its root AGENTS.md
// requires for every change there, and the sparse checkout of step 1 leaves
// that `.agents/` out when the change touches only the package's `src/`. So the
// listing never named them. The second loop reads them from the index for each
// touched directory and its parents.

const stepThreeScriptFor = (dirs: string): string => {
  const section = skill.slice(skill.indexOf("## 3."), skill.indexOf("## 4."));
  const match = /```bash\n([\s\S]*?)\n```/u.exec(section);
  if (match?.[1] === undefined) throw new Error("step 3 has no bash block");
  return match[1].replaceAll("<dirs the change touches>", dirs);
};

const git = (args: string[], cwd: string) => {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
};

const write = (root: string, path: string, content: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
};

describe("open-pr step 3 lists the skills a touched package keeps beside its code", () => {
  test("a package skill outside the sparse checkout is listed for a change under that package", () => {
    const root = mkdtempSync(join(tmpdir(), "wwg-open-pr-nested-"));
    try {
      const src = join(root, "src");
      write(src, ".agents/skills/root-skill/SKILL.md", "---\nname: root-skill\ndescription: Root work.\n---\n");
      write(src, "apps/desktop/.agents/skills/prove-flow/SKILL.md", "---\nname: prove-flow\ndescription: >\n  Prove a desktop\n  flow end to end.\n---\n");
      write(src, "apps/desktop/src/main.ts", "export {};\n");
      write(src, "apps/web/.claude/skills/web-only/SKILL.md", "---\nname: web-only\ndescription: Web work.\n---\n");
      write(src, "apps/web/src/main.ts", "export {};\n");
      git(["init", "-q", "-b", "main"], src);
      git(["add", "-A"], src);
      git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], src);
      git(["config", "uploadpack.allowFilter", "true"], src);
      const wt = join(root, "wt");
      git(["clone", "-q", "--filter=blob:none", "--sparse", `file://${src}`, wt], root);
      git(["sparse-checkout", "set", "--skip-checks", ".agents", "apps/desktop/src"], wt);
      for (const dirs of ["apps/desktop/src", `"$WT/apps/desktop/src"`]) {
        const proc = Bun.spawnSync(["bash", "-c", stepThreeScriptFor(dirs)], {
          cwd: root,
          env: { ...process.env, WT: wt },
          stderr: "pipe",
          stdout: "pipe",
          timeout: 10_000,
        });
        expect(proc.signalCode).toBeFalsy();
        const out = proc.stdout.toString();
        expect(out).toContain("root-skill/SKILL.md: Root work.\n");
        expect(out).toContain("apps/desktop/.agents/skills/prove-flow/SKILL.md: Prove a desktop flow end to end.\n");
        expect(out).not.toContain("web-only");
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("open-pr step 3 lists the skills in GitHub's own skills folder", () => {
  // BabylonJS/Babylon.js keeps its create-pr and monitor-pr skills in
  // .github/skills/<name>/SKILL.md, one of the three places GitHub's agents
  // read project skills from, and the root loop never looked there.
  test("a skill under .github/skills is listed like one under .agents/skills", () => {
    const wt = mkdtempSync(join(tmpdir(), "wwg-open-pr-desc-"));
    try {
      mkdirSync(join(wt, ".github/skills/create-pr"), { recursive: true });
      writeFileSync(
        join(wt, ".github/skills/create-pr/SKILL.md"),
        "---\nname: create-pr\ndescription: |\n    Orchestrates the full PR lifecycle.\n---\n\n# create-pr\n",
      );
      commitAll(wt);
      const proc = Bun.spawnSync(["bash", "-c", stepThreeScript().replaceAll("<dirs the change touches>", "src")], {
        env: { ...process.env, WT: wt },
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(proc.stdout.toString()).toContain(".github/skills/create-pr/SKILL.md: Orchestrates the full PR lifecycle.\n");
    } finally {
      rmSync(wt, { force: true, recursive: true });
    }
  });
});

// Regression: step 3 listed `.cursor/rules/*` by `description` only, from the
// disk. Cursor applies a rule with `alwaysApply: true` to every request, and
// many leave its description empty (ClickHouse/ai-sdk-cpp keeps its C++ style
// rules in one), so the listing showed a blank line and the agent read none of
// it. Rules in subfolders (growthbook/growthbook keeps `.cursor/rules/frontend/`
// and `/backend/`) were never listed at all.
describe("open-pr step 3 reads Cursor rules the way Cursor applies them", () => {
  test("an alwaysApply rule prints in full, a nested scoped rule lists its description and globs", () => {
    const root = mkdtempSync(join(tmpdir(), "wwg-open-pr-cursor-"));
    try {
      const src = join(root, "src");
      write(src, ".cursor/rules/cpp.mdc", "---\ndescription: \nglobs: \nalwaysApply: true\n---\n\n1. prefer one class per file.\n");
      write(src, ".cursor/rules/crlf.mdc", "---\r\ndescription:\r\nalwaysApply: true\r\n---\r\nUse nullptr.\r\n");
      // Committed as a link to a shared rule: git show printed only its target path.
      write(src, "docs/rules/go.mdc", "---\nalwaysApply: true\n---\nWrap every error.\n");
      mkdirSync(join(src, ".cursor/rules"), { recursive: true });
      symlinkSync("../../docs/rules/go.mdc", join(src, ".cursor/rules/go.mdc"));
      write(src, ".cursor/rules/frontend/react.mdc", '---\ndescription: "React conventions"\nglobs: packages/front-end/**/*.tsx\nalwaysApply: false\n---\n# React\n');
      write(src, "src/main.ts", "export {};\n");
      git(["init", "-q", "-b", "main"], src);
      git(["add", "-A"], src);
      git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], src);
      git(["config", "uploadpack.allowFilter", "true"], src);
      const wt = join(root, "wt");
      git(["clone", "-q", "--filter=blob:none", "--sparse", `file://${src}`, wt], root);
      git(["sparse-checkout", "set", "--skip-checks", "src"], wt);
      const proc = Bun.spawnSync(["bash", "-c", stepThreeScriptFor("src")], {
        cwd: root,
        env: { ...process.env, WT: wt },
        stderr: "pipe",
        stdout: "pipe",
        timeout: 10_000,
      });
      const out = proc.stdout.toString();
      expect(out).toContain("===== .cursor/rules/cpp.mdc (alwaysApply)\n---\ndescription: \nglobs: \nalwaysApply: true\n---\n\n1. prefer one class per file.");
      expect(out).toContain("===== .cursor/rules/crlf.mdc (alwaysApply)");
      expect(out).toContain("Use nullptr.");
      expect(out).toContain('.cursor/rules/frontend/react.mdc: "React conventions" (globs packages/front-end/**/*.tsx)\n');
      expect(out).not.toContain("===== .cursor/rules/frontend/react.mdc");
      expect(out).toContain("===== .cursor/rules/go.mdc (alwaysApply)\n---\nalwaysApply: true\n---\nWrap every error.");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

// Regression: step 3 listed only `.agents/skills`, `.claude/skills` and
// `.github/skills`, but other agents load their own folders, read from their
// loader source. Codex makes every `.codex/` folder between the project root
// and its working directory a config layer, config.toml or not, and loads its
// `skills/` (openai/codex config/src/loader/mod.rs, ext/skills/src/
// host_roots.rs). Gemini CLI loads `<root>/.gemini/skills` (core/src/config/
// storage.ts getProjectSkillsDir). OpenCode scans `{skill,skills}/**/SKILL.md`
// under each `.opencode` directory up to the worktree (opencode v1.19.6
// src/skill/index.ts). Many repositories keep skills only there: in samples,
// 59 of 130 `.codex/skills` repos (riaf/relqis `pr-checker`), 34 of 55
// `.opencode/skills`, 18 of 30 `.opencode/skill`, 8 of 32 `.gemini/skills`.
// Step 1's sparse set left those folders out, and step 3 listed none of them.
describe("open-pr step 3 lists the skills Codex, Gemini CLI and OpenCode load", () => {
  test("root and package skills in their folders are listed from a sparse clone", () => {
    const root = mkdtempSync(join(tmpdir(), "wwg-open-pr-codex-"));
    try {
      const src = join(root, "src");
      write(src, ".codex/skills/pr-checker/SKILL.md", "---\nname: pr-checker\ndescription: Check a PR before it opens.\n---\n");
      write(src, ".gemini/skills/zig/SKILL.md", "---\nname: zig\ndescription: Zig style.\n---\n");
      write(src, ".opencode/skill/code-reviewer/SKILL.md", "---\nname: code-reviewer\ndescription: Review code.\n---\n");
      write(src, ".opencode/skills/tdd/SKILL.md", "---\nname: tdd\ndescription: Test first.\n---\n");
      write(src, "pkg/.codex/skills/commit/SKILL.md", "---\nname: commit\ndescription: Commit in this package's format.\n---\n");
      write(src, "pkg/.opencode/skills/release/SKILL.md", "---\nname: release\ndescription: Release the package.\n---\n");
      write(src, "pkg/src/main.ts", "export {};\n");
      git(["init", "-q", "-b", "main"], src);
      git(["add", "-A"], src);
      git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], src);
      git(["config", "uploadpack.allowFilter", "true"], src);
      const wt = join(root, "wt");
      git(["clone", "-q", "--depth", "1", "--filter=blob:none", "--sparse", `file://${src}`, wt], root);
      const stepOne = skill.slice(skill.indexOf("## 1."), skill.indexOf("## 2."));
      const set = /```bash\n([\s\S]*?)\n```/u.exec(stepOne)?.[1]?.split("\n").find((l) => l.startsWith("git sparse-checkout set"));
      if (set === undefined) throw new Error("step 1 has no sparse-checkout set");
      expect(Bun.spawnSync(["bash", "-c", set.replace("<dirs the change touches>", "pkg/src")], { cwd: wt }).exitCode).toBe(0);
      const proc = Bun.spawnSync(["bash", "-c", stepThreeScriptFor("pkg/src")], {
        cwd: root,
        env: { ...process.env, WT: wt },
        stderr: "pipe",
        stdout: "pipe",
        timeout: 10_000,
      });
      const out = proc.stdout.toString();
      for (const line of [
        ".codex/skills/pr-checker/SKILL.md: Check a PR before it opens.\n",
        ".gemini/skills/zig/SKILL.md: Zig style.\n",
        ".opencode/skill/code-reviewer/SKILL.md: Review code.\n",
        ".opencode/skills/tdd/SKILL.md: Test first.\n",
        "pkg/.codex/skills/commit/SKILL.md: Commit in this package's format.\n",
        "pkg/.opencode/skills/release/SKILL.md: Release the package.\n",
      ]) expect(out).toContain(line);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

// Regression: step 3 listed the root skill folders from the disk and a
// package's from `ls-tree`, and neither reads through a link. Claude Code
// follows a linked skills folder and a linked skill ("A session loading this
// project does follow it", its own `plugin validate` on keybase/client), and
// repositories link both to folders step 1's sparse set leaves out:
// keybase/client's `.claude/skills` links to `../skill` (16 skills, one of
// them address-pr-feedback), VirtusLab/scala-cli's to `../agentskills` (11),
// pelikan-io/pelikan's `.claude/skills/run` to `../../.agent/skills/run`. On
// the disk each link dangled, and in the index it is one entry, so the
// listing named none of those skills.
describe("open-pr step 3 lists skills through linked folders", () => {
  test("a linked skills folder and a linked skill, at the root and in a package, are listed from a sparse clone", () => {
    const root = mkdtempSync(join(tmpdir(), "wwg-open-pr-linked-skills-"));
    try {
      const src = join(root, "src");
      write(src, "skill/address-pr-feedback/SKILL.md", "---\nname: address-pr-feedback\ndescription: Answer every review thread.\n---\n");
      write(src, ".agent/skills/run/SKILL.md", "---\nname: run\ndescription: Run the server locally.\n---\n");
      write(src, "pkg/shared/release/SKILL.md", "---\nname: release\ndescription: Release the package.\n---\n");
      write(src, "pkg/src/main.ts", "export {};\n");
      mkdirSync(join(src, ".claude"), { recursive: true });
      symlinkSync("../skill/", join(src, ".claude/skills"));
      mkdirSync(join(src, ".agents/skills"), { recursive: true });
      symlinkSync("../../.agent/skills/run", join(src, ".agents/skills/run"));
      mkdirSync(join(src, "pkg/.claude"), { recursive: true });
      symlinkSync("../shared", join(src, "pkg/.claude/skills"));
      git(["init", "-q", "-b", "main"], src);
      git(["add", "-A"], src);
      git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], src);
      git(["config", "uploadpack.allowFilter", "true"], src);
      const wt = join(root, "wt");
      git(["clone", "-q", "--depth", "1", "--filter=blob:none", "--sparse", `file://${src}`, wt], root);
      const stepOne = skill.slice(skill.indexOf("## 1."), skill.indexOf("## 2."));
      const set = /```bash\n([\s\S]*?)\n```/u.exec(stepOne)?.[1]?.split("\n").find((l) => l.startsWith("git sparse-checkout set"));
      if (set === undefined) throw new Error("step 1 has no sparse-checkout set");
      expect(Bun.spawnSync(["bash", "-c", set.replace("<dirs the change touches>", "pkg/src")], { cwd: wt }).exitCode).toBe(0);
      const proc = Bun.spawnSync(["bash", "-c", stepThreeScriptFor("pkg/src")], {
        cwd: root,
        env: { ...process.env, WT: wt },
        stderr: "pipe",
        stdout: "pipe",
        timeout: 10_000,
      });
      const out = proc.stdout.toString();
      for (const line of [
        ".claude/skills/address-pr-feedback/SKILL.md: Answer every review thread.\n",
        ".agents/skills/run/SKILL.md: Run the server locally.\n",
        "pkg/.claude/skills/release/SKILL.md: Release the package.\n",
      ]) expect(out).toContain(line);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

// Regression: step 3 read Cursor's rules only from the root `.cursor/rules`,
// with `ls-tree`, and never Cursor's skills. Cursor's own agent (cursor-agent
// 2026.11.22, loadFresh) globs "**/.cursor/rules/**/*.mdc" and
// "**/.cursor/skills/**/SKILL.md" in every directory and walks with
// followSymlinks: true. gambitph/Stackable keeps its 38 skills (to-quality-pr,
// code-review, ensure-quality, tdd) only in `.cursor/skills`; tabler/tabler,
// qiniu/go-sdk and dozens more link `.cursor/rules` to `../.agents/rules`, one
// index entry `ls-tree` listed no rule under; and packages keep their own
// rules (about 200 files under `apps/web/.cursor/rules`, 680 under
// `frontend/.cursor/rules`).
describe("open-pr step 3 reads Cursor's rules and skills the way Cursor loads them", () => {
  test("root and package .cursor/skills, a linked .cursor/rules and a package's .cursor/rules are read", () => {
    const root = mkdtempSync(join(tmpdir(), "wwg-open-pr-cursor-loader-"));
    try {
      const src = join(root, "src");
      write(src, ".cursor/skills/to-quality-pr/SKILL.md", "---\nname: to-quality-pr\ndescription: Turn a branch into a quality PR.\n---\n");
      write(src, "apps/web/.cursor/skills/storybook/SKILL.md", "---\nname: storybook\ndescription: Add a story per component.\n---\n");
      write(src, ".agents/rules/typescript.mdc", "---\nalwaysApply: true\n---\nNo any, ever.\n");
      symlinkSync("../.agents/rules", join(src, ".cursor/rules"));
      write(src, "apps/web/.cursor/rules/web.mdc", "---\ndescription: Web app rules\nglobs: apps/web/**/*.tsx\n---\n# Web\n");
      write(src, "apps/web/src/main.tsx", "export {};\n");
      git(["init", "-q", "-b", "main"], src);
      git(["add", "-A"], src);
      git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], src);
      git(["config", "uploadpack.allowFilter", "true"], src);
      const wt = join(root, "wt");
      git(["clone", "-q", "--depth", "1", "--filter=blob:none", "--sparse", `file://${src}`, wt], root);
      const stepOne = skill.slice(skill.indexOf("## 1."), skill.indexOf("## 2."));
      const set = /```bash\n([\s\S]*?)\n```/u.exec(stepOne)?.[1]?.split("\n").find((l) => l.startsWith("git sparse-checkout set"));
      if (set === undefined) throw new Error("step 1 has no sparse-checkout set");
      expect(Bun.spawnSync(["bash", "-c", set.replace("<dirs the change touches>", "apps/web/src")], { cwd: wt }).exitCode).toBe(0);
      const proc = Bun.spawnSync(["bash", "-c", stepThreeScriptFor("apps/web/src")], {
        cwd: root,
        env: { ...process.env, WT: wt },
        stderr: "pipe",
        stdout: "pipe",
        timeout: 10_000,
      });
      const out = proc.stdout.toString();
      expect(out).toContain(".cursor/skills/to-quality-pr/SKILL.md: Turn a branch into a quality PR.\n");
      expect(out).toContain("apps/web/.cursor/skills/storybook/SKILL.md: Add a story per component.\n");
      expect(out).toContain("===== .cursor/rules/typescript.mdc (alwaysApply)\n---\nalwaysApply: true\n---\nNo any, ever.");
      expect(out).toContain("apps/web/.cursor/rules/web.mdc: Web app rules (globs apps/web/**/*.tsx)\n");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
