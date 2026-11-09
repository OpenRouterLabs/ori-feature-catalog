import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression: step 2 read the rules files with `[ -f "$f" ]` on the disk of
// step 1's sparse clone. The sparse set never checks out `docs/`, where GitHub
// also reads a PR template and a CONTRIBUTING file, nor `.cursor/`, `.circleci/`
// or `.buildkite/`, which steps 2 and 3 list, so all of them were skipped
// without a word, and a root `pull_request_template.md` (GitHub matches the
// name in any case) was never in the list at all.

const skill = readFileSync(join(import.meta.dir, "skills/open-pr/SKILL.md"), "utf8");

const bashBlock = (from: string, to: string): string => {
  const section = skill.slice(skill.indexOf(from), skill.indexOf(to));
  const match = /```bash\n([\s\S]*?)\n```/u.exec(section);
  if (match?.[1] === undefined) throw new Error(`${from} has no bash block`);
  return match[1];
};

const sparseSet = (): string => {
  const line = bashBlock("## 1.", "## 2.").split("\n").find((l) => l.startsWith("git sparse-checkout set"));
  if (line === undefined) throw new Error("step 1 has no sparse-checkout set");
  return line.replace("<dirs the change touches>", "src");
};

const git = (args: string[], cwd: string) => {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
};

describe("open-pr step 2 reads the rules a sparse clone leaves off the disk", () => {
  test("a docs/ PR template and CONTRIBUTING, a lower-case root template, and .cursor rules", () => {
    const root = mkdtempSync(join(tmpdir(), "wwg-open-pr-sparse-"));
    try {
      const src = join(root, "src");
      for (const dir of ["docs", ".cursor/rules", "src"]) mkdirSync(join(src, dir), { recursive: true });
      writeFileSync(join(src, "docs/pull_request_template.md"), "## Linear ticket\n");
      writeFileSync(join(src, "docs/CONTRIBUTING.md"), "docs contributing rules\n");
      writeFileSync(join(src, "pull_request_template.md"), "## Root template\n");
      writeFileSync(join(src, ".cursor/rules/pr.mdc"), "cursor rule\n");
      writeFileSync(join(src, "src/a.ts"), "export {};\n");
      writeFileSync(join(src, "AGENTS.md"), "agents rules\n");
      git(["init", "-q", "-b", "main"], src);
      git(["add", "-A"], src);
      git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], src);
      git(["config", "uploadpack.allowFilter", "true"], src);
      const wt = join(root, "wt");
      git(["clone", "-q", "--depth", "1", "--filter=blob:none", "--sparse", `file://${src}`, wt], root);
      const set = Bun.spawnSync(["bash", "-c", sparseSet()], { cwd: wt, stderr: "pipe" });
      expect(set.exitCode).toBe(0);
      const proc = Bun.spawnSync(["bash", "-c", bashBlock("## 2.", "## 3.").replaceAll("<dirs the change touches>", "src")], {
        cwd: wt,
        env: { ...process.env, WT: wt },
        stderr: "pipe",
        stdout: "pipe",
        timeout: 10_000,
      });
      const out = proc.stdout.toString();
      expect(out).toContain("===== AGENTS.md\nagents rules");
      expect(out).toContain("===== docs/pull_request_template.md\n## Linear ticket");
      expect(out).toContain("===== docs/CONTRIBUTING.md\ndocs contributing rules");
      expect(out).toContain("===== pull_request_template.md\n## Root template");
      expect(readFileSync(join(wt, ".cursor/rules/pr.mdc"), "utf8")).toBe("cursor rule\n");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

// Regression: step 2 read AGENTS.md and CLAUDE.md but never GitHub's own agent
// rules. BabylonJS/Babylon.js keeps its "Quality commands" (format, lint, build,
// unit tests, "All must pass before committing") only in
// .github/copilot-instructions.md, and path-scoped rules in
// .github/instructions/*.instructions.md with an `applyTo` glob, so the agent
// read none of them and pushed without the checks the repository asks for.
describe("open-pr step 2 reads the repository's Copilot instructions", () => {
  const stepTwo = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), "wwg-open-pr-copilot-"));
    try {
      const src = join(root, "src");
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(src, path, ".."), { recursive: true });
        writeFileSync(join(src, path), content);
      }
      git(["init", "-q", "-b", "main"], src);
      git(["add", "-A"], src);
      git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], src);
      git(["config", "uploadpack.allowFilter", "true"], src);
      const wt = join(root, "wt");
      git(["clone", "-q", "--depth", "1", "--filter=blob:none", "--sparse", `file://${src}`, wt], root);
      expect(Bun.spawnSync(["bash", "-c", sparseSet()], { cwd: wt, stderr: "pipe" }).exitCode).toBe(0);
      const proc = Bun.spawnSync(["bash", "-c", bashBlock("## 2.", "## 3.").replaceAll("<dirs the change touches>", "src")], {
        cwd: wt,
        env: { ...process.env, WT: wt },
        stderr: "pipe",
        stdout: "pipe",
        timeout: 10_000,
      });
      return proc.stdout.toString();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  };

  test("copilot-instructions.md is printed in full, each .instructions.md is listed with its applyTo", () => {
    const out = stepTwo({
      ".github/copilot-instructions.md": "## Quality commands\n\nnpm run lint:check\n",
      ".github/instructions/tests.instructions.md": '---\napplyTo: "packages/dev/**/*.ts"\n---\n\n# Unit Tests\n',
      ".github/instructions/react.instructions.md": '---\r\napplyTo: "**/*.tsx"\r\n---\r\n# React\r\n',
      "src/a.ts": "export {};\n",
    });
    expect(out).toContain("===== .github/copilot-instructions.md\n## Quality commands\n\nnpm run lint:check");
    expect(out).toContain('.github/instructions/tests.instructions.md: applyTo "packages/dev/**/*.ts"');
    expect(out).toContain('.github/instructions/react.instructions.md: applyTo "**/*.tsx"\n');
  });
});
