import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression: a repository with no PR template or CONTRIBUTING of its own gets
// the ones in its owner's public `.github` repository: GitHub fills the PR form
// from that default template. Step 2 read only the repository's own tree, so on
// expressjs/cors (no template; expressjs/.github ships a PULL_REQUEST_TEMPLATE.md
// and a CONTRIBUTING.md) it printed no template at all, and step 6 fell back to
// "## Summary / ## Why / ## Test plan" in place of the form the owner requires.

const skill = readFileSync(join(import.meta.dir, "skills/open-pr/SKILL.md"), "utf8");
const section = skill.slice(skill.indexOf("## 2."), skill.indexOf("## 3."));
const block = /```bash\n([\s\S]*?)\n```/u.exec(section)?.[1] ?? "";
const fallback = block.slice(block.indexOf("# No PR template"));

const git = (args: string[], cwd: string) => {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
};

const repo = (dir: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(["init", "-q", "-b", "main"], dir);
  git(["add", "-A"], dir);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], dir);
  git(["config", "uploadpack.allowFilter", "true"], dir);
};

// The owner's `.github` repository is served from a local bare path: git's
// url.<base>.insteadOf rewrites the https://github.com/<owner>/.github.git
// URL the block clones, so the test never touches the network.
const run = (own: Record<string, string>, owner: Record<string, string> | undefined) => {
  const root = mkdtempSync(join(tmpdir(), "wwg-open-pr-owner-"));
  try {
    const wt = join(root, "wt");
    repo(wt, { "src/a.ts": "export {};\n", ...own });
    const gitConfig = join(root, "gitconfig");
    if (owner !== undefined) {
      repo(join(root, "owner"), owner);
      writeFileSync(gitConfig, `[url "file://${join(root, "owner")}"]\n\tinsteadOf = https://github.com/acme/.github.git\n`);
    } else {
      writeFileSync(gitConfig, `[url "file://${join(root, "missing")}"]\n\tinsteadOf = https://github.com/acme/.github.git\n`);
    }
    const proc = Bun.spawnSync(["bash", "-c", fallback], {
      cwd: wt,
      env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1", REPO: "acme/widgets", WT: wt },
      stderr: "pipe",
      stdout: "pipe",
      timeout: 20_000,
    });
    return { code: proc.exitCode, out: proc.stdout.toString() };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

describe("open-pr step 2 reads the owner's default PR template and CONTRIBUTING", () => {
  test("a repo with neither prints both from the owner's .github repository", () => {
    const { out } = run({}, {
      ".github/PULL_REQUEST_TEMPLATE.md": "## Certificate of Origin",
      "CONTRIBUTING.md": "sign off every commit",
      "profile/README.md": "not a rules file\n",
    });
    expect(out).toContain("===== acme/.github: .github/PULL_REQUEST_TEMPLATE.md\n## Certificate of Origin\n");
    expect(out).toContain("===== acme/.github: CONTRIBUTING.md\nsign off every commit\n");
    expect(out).not.toContain("not a rules file");
  });

  test("a repo's own template wins and the default one is never printed", () => {
    const { out } = run({ "docs/pull_request_template.md": "## Own\n" }, {
      ".github/pull_request_template.md": "## Default\n",
      "CONTRIBUTING.md": "default contributing\n",
    });
    expect(out).not.toContain("## Default");
    expect(out).toContain("===== acme/.github: CONTRIBUTING.md\ndefault contributing");
  });

  test("a repo with both of its own never clones the owner's repository", () => {
    const { out } = run({ ".github/pull_request_template.md": "## Own\n", "CONTRIBUTING.md": "own\n" }, {
      ".github/pull_request_template.md": "## Default\n",
    });
    expect(out).toBe("");
  });

  test("a template directory in the owner's repository is printed file by file", () => {
    const { out } = run({}, {
      ".github/PULL_REQUEST_TEMPLATE/bug.md": "## Bug\n",
      ".github/PULL_REQUEST_TEMPLATE/feature.md": "## Feature\n",
    });
    expect(out).toContain("===== acme/.github: .github/PULL_REQUEST_TEMPLATE/bug.md\n## Bug");
    expect(out).toContain("===== acme/.github: .github/PULL_REQUEST_TEMPLATE/feature.md\n## Feature");
  });

  test("an owner with no .github repository prints nothing and the block still succeeds", () => {
    const { code, out } = run({}, undefined);
    expect(out).toBe("");
    expect(code).toBe(0);
  });
});
