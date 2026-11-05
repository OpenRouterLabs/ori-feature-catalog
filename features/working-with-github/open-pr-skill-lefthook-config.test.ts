import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression: step 2 listed lefthook's config only as `lefthook.yml` or
// `lefthook.yaml`. Lefthook reads its main config as `lefthook` or
// `.lefthook`, each with a .yml, .yaml, .json or .toml extension, so a repo
// whose hooks live in `.lefthook.yml` or `lefthook.toml` had its hook config
// skipped without a word, and step 4 never ran the checks those hooks run.

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

const stepTwoOutput = (config: string): string => {
  const root = mkdtempSync(join(tmpdir(), "wwg-open-pr-lefthook-"));
  try {
    const src = join(root, "src");
    mkdirSync(join(src, "src"), { recursive: true });
    writeFileSync(join(src, config), `pre-commit from ${config}\n`);
    writeFileSync(join(src, "src/a.ts"), "export {};\n");
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
    return proc.stdout.toString();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

describe("open-pr step 2 reads every lefthook config name lefthook loads", () => {
  for (const config of [
    "lefthook.yml",
    "lefthook.yaml",
    ".lefthook.yml",
    ".lefthook.yaml",
    "lefthook.toml",
    ".lefthook.toml",
    "lefthook.json",
    ".lefthook.json",
  ]) {
    test(`${config} is printed in full`, () => {
      expect(stepTwoOutput(config)).toContain(`===== ${config}\npre-commit from ${config}`);
    });
  }

  test("a lookalike that lefthook does not load stays out", () => {
    expect(stepTwoOutput("lefthook.yml.bak")).not.toContain("===== lefthook.yml.bak");
  });
});
