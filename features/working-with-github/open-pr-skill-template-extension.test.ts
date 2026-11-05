import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression: step 2 matched a PR template only as `pull_request_template.md`
// and a contributing file only as `contributing` or `contributing.md`. GitHub
// reads both with any extension (its docs name `.md` or `.txt` for the
// template, and render CONTRIBUTING in whatever markup its extension names),
// so a repo whose template is `.github/pull_request_template.txt` or whose
// guide is `CONTRIBUTING.rst` had it skipped without a word, and the PR body
// ignored the template GitHub itself pre-fills.

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


const stepTwoOutput = (files: readonly string[]): string => {
  const root = mkdtempSync(join(tmpdir(), "wwg-open-pr-template-ext-"));
  try {
    const src = join(root, "src");
    for (const file of [...files, "src/a.ts"]) {
      mkdirSync(join(src, file, ".."), { recursive: true });
      writeFileSync(join(src, file), `body of ${file}\n`);
    }
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

describe("open-pr step 2 reads a PR template and CONTRIBUTING with any extension", () => {
  for (const file of [
    ".github/pull_request_template.txt",
    "docs/PULL_REQUEST_TEMPLATE",
    "pull_request_template.markdown",
    "CONTRIBUTING.rst",
    "docs/contributing.txt",
    ".github/CONTRIBUTING.adoc",
  ]) {
    test(`${file} is printed in full`, () => {
      expect(stepTwoOutput([file])).toContain(`===== ${file}\nbody of ${file}`);
    });
  }

  test("lookalikes GitHub does not read stay out", () => {
    const out = stepTwoOutput(["src/CONTRIBUTING.md", "docs/sub/pull_request_template.md", "contributingx.md"]);
    expect(out).not.toContain("===== src/CONTRIBUTING.md");
    expect(out).not.toContain("===== docs/sub/pull_request_template.md");
    expect(out).not.toContain("===== contributingx.md");
  });
});
