import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression: step 2 listed lefthook's config only as `lefthook.yml` or
// `lefthook.yaml`. Lefthook reads its main config as `lefthook` or
// `.lefthook`, each with a .yml, .yaml, .json or .toml extension, so a repo
// whose hooks live in `.lefthook.yml` or `lefthook.toml` had its hook config
// skipped without a word, and step 4 never ran the checks those hooks run.
// Lefthook also reads `.config/lefthook.*`, a `.jsonc` extension, and merges
// a `lefthook-local` config of every one of those forms; its scripts may live
// under `.config/lefthook/<hook>/` too. All of those were skipped as well.

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

const stepTwoOutput = (config: string, content = `pre-commit from ${config}\n`): string => {
  const root = mkdtempSync(join(tmpdir(), "wwg-open-pr-lefthook-"));
  try {
    const src = join(root, "src");
    mkdirSync(join(src, "src"), { recursive: true });
    mkdirSync(join(src, config, ".."), { recursive: true });
    writeFileSync(join(src, config), content);
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
    "lefthook.jsonc",
    ".lefthook.jsonc",
    ".config/lefthook.yml",
    ".config/lefthook.yaml",
    ".config/lefthook.toml",
    ".config/lefthook.json",
    ".config/lefthook.jsonc",
    "lefthook-local.yml",
    ".lefthook-local.json",
    ".config/lefthook-local.toml",
  ]) {
    test(`${config} is printed in full`, () => {
      expect(stepTwoOutput(config)).toContain(`===== ${config}\npre-commit from ${config}`);
    });
  }

  test("a lookalike that lefthook does not load stays out", () => {
    expect(stepTwoOutput("lefthook.yml.bak")).not.toContain("===== lefthook.yml.bak");
    expect(stepTwoOutput(".config/.lefthook.yml")).not.toContain("===== .config/.lefthook.yml");
  });

  test("a hook script under .config/lefthook/<hook>/ is checked out and printed", () => {
    for (const script of [".config/lefthook/pre-commit/lint.sh", ".config/lefthook-local/pre-push/check.sh"]) {
      expect(stepTwoOutput(script)).toContain(`===== ${script}\npre-commit from ${script}`);
    }
  });
});

// Regression: husky before v5 loads its hooks through cosmiconfig("husky")
// (`.huskyrc`, `.huskyrc.{json,yaml,yml,js,cjs}`, `husky.config.{js,cjs}`),
// and overcommit merges `.local-overcommit.yml` over `.overcommit.yml`
// (its configuration_loader.rb). Step 2 printed none of them, so a repo whose
// hooks live there had them skipped without a word.
describe("open-pr step 2 reads husky v4 and overcommit-local hook configs", () => {
  for (const config of [
    ".huskyrc",
    ".huskyrc.json",
    ".huskyrc.yaml",
    ".huskyrc.yml",
    ".huskyrc.js",
    ".huskyrc.cjs",
    "husky.config.js",
    "husky.config.cjs",
    ".local-overcommit.yml",
  ]) {
    test(`${config} is printed in full`, () => {
      expect(stepTwoOutput(config)).toContain(`===== ${config}\npre-commit from ${config}`);
    });
  }

  test("a lookalike husky does not load stays out", () => {
    expect(stepTwoOutput(".huskyrc.bak")).not.toContain("===== .huskyrc.bak");
    expect(stepTwoOutput("husky.config.ts")).not.toContain("===== husky.config.ts");
  });
});

// Regression: most husky and simple-git-hooks `pre-commit` hooks only call
// `lint-staged`, and the commands it runs live in its own config, which
// step 2 never listed (lint-staged's lib/configFiles.js: `.lintstagedrc*`,
// `lint-staged.config.*`, in any directory, or the `lint-staged` key of
// package.json). simple-git-hooks (`.simple-git-hooks.*`, `simple-git-hooks.*`
// or its package.json key) was not listed at all, and the package.json keys
// of husky v4 and commitlint were left to the reader. On vercel/next.js step 2
// printed the PR template and AGENTS.md but not lint-staged.config.js, where
// its `pnpm lint-staged` hook keeps prettier --write and eslint --fix.
describe("open-pr step 2 reads lint-staged and simple-git-hooks configs", () => {
  for (const config of [
    ".lintstagedrc",
    ".lintstagedrc.json",
    ".lintstagedrc.yaml",
    ".lintstagedrc.yml",
    ".lintstagedrc.mjs",
    ".lintstagedrc.mts",
    ".lintstagedrc.js",
    ".lintstagedrc.ts",
    ".lintstagedrc.cjs",
    ".lintstagedrc.cts",
    "lint-staged.config.mjs",
    "lint-staged.config.mts",
    "lint-staged.config.js",
    "lint-staged.config.ts",
    "lint-staged.config.cjs",
    "lint-staged.config.cts",
    "packages/app/.lintstagedrc.json",
    ".simple-git-hooks.cjs",
    ".simple-git-hooks.js",
    ".simple-git-hooks.mjs",
    ".simple-git-hooks.json",
    "simple-git-hooks.cjs",
    "simple-git-hooks.js",
    "simple-git-hooks.mjs",
    "simple-git-hooks.json",
  ]) {
    test(`${config} is printed in full`, () => {
      expect(stepTwoOutput(config)).toContain(`===== ${config}\npre-commit from ${config}`);
    });
  }

  test("a lookalike neither tool loads stays out", () => {
    expect(stepTwoOutput(".lintstagedrc.bak")).not.toContain("===== .lintstagedrc.bak");
    expect(stepTwoOutput("simple-git-hooks.ts")).not.toContain("===== simple-git-hooks.ts");
  });

  test("the hook keys of package.json are printed, and nothing else of it", () => {
    const pkg = JSON.stringify({
      commitlint: { extends: ["@commitlint/config-conventional"] },
      husky: { hooks: { "pre-push": "npm test" } },
      "lint-staged": { "*.ts": "eslint --fix" },
      name: "fixture",
      scripts: { build: "tsc" },
      "simple-git-hooks": { "pre-commit": "npx lint-staged" },
    });
    const out = stepTwoOutput("package.json", pkg);
    for (const key of ["husky", "simple-git-hooks", "lint-staged", "commitlint"]) {
      expect(out).toContain(`===== package.json "${key}"`);
    }
    expect(out).toContain('"*.ts": "eslint --fix"');
    expect(out).toContain('"pre-commit": "npx lint-staged"');
    expect(out).not.toContain("fixture");
    expect(out).not.toContain('"build"');
  });

  test("a package.json with no hook keys, or none at all, prints nothing of it", () => {
    expect(stepTwoOutput("package.json", '{"name":"fixture"}')).not.toContain("===== package.json");
    expect(stepTwoOutput("src/b.ts")).not.toContain("===== package.json");
  });
});
