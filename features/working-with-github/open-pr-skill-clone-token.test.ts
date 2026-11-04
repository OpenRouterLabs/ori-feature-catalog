import { describe, expect, test } from "bun:test";
// The skill told App mode to put the token in the clone URL "for that one
// command, never in git config". `git clone` saves the URL it was given as the
// clone's `origin`, userinfo included, so the token landed in `.git/config`,
// where `git remote -v` prints it and every later fetch of the partial clone
// (sparse-checkout, switch) sends it again after it expires. The skill now
// reads the rotated GH_TOKEN through a credential helper that stores only the
// variable's name.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const skill = readFileSync(join(import.meta.dir, "skills/open-pr/SKILL.md"), "utf8");
const stepOne = skill.slice(skill.indexOf("## 1."), skill.indexOf("## 2."));
const appBlock = (): string => {
  const start = stepOne.indexOf("  ```bash\n  AUTH=");
  if (start === -1) throw new Error("step 1 has no App-mode credential block");
  const body = stepOne.slice(start + "  ```bash\n".length, stepOne.indexOf("  ```\n", start + 1));
  return body.replace(/^ {2}/gmu, "");
};

const token = "ghs_FAKE0000000000000000000000000000token";

const bash = (script: string, cwd: string) =>
  Bun.spawnSync(["bash", "-c", script], {
    cwd,
    env: { ...process.env, GH_TOKEN: token, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", HOME: cwd },
    stderr: "pipe",
    stdout: "pipe",
  });

describe("open-pr step 1 keeps the App token out of the clone's git config", () => {
  test("the skill never says to put the token in the clone URL", () => {
    expect(stepOne).not.toContain("In App mode, put the token in the clone URL");
    expect(stepOne).not.toMatch(/x-access-token:\$\{?(GH_)?TOKEN/u);
    expect(stepOne).toContain("never put the token in the clone URL");
  });

  test("the clone and its config carry the helper, never the token, and the helper answers with GH_TOKEN", () => {
    const dir = mkdtempSync(join(tmpdir(), "wwg-open-pr-clone-token-"));
    try {
      const lines = appBlock().split("\n");
      const auth = lines.find((line) => line.startsWith("AUTH="));
      const clone = lines.find((line) => line.startsWith("git -c credential.https://github.com.helper="));
      const persist = lines.find((line) => line.startsWith('git -C "$WT" config'));
      expect(auth).toBeDefined();
      expect(clone).toContain('clone -q --depth 1 --filter=blob:none --sparse "https://github.com/$REPO.git" "$WT"');
      expect(persist).toBeDefined();
      const wt = join(dir, "wt");
      const run = bash(
        [
          `WT=${JSON.stringify(wt)}`,
          "git init -q \"$WT\"",
          'git -C "$WT" remote add origin https://github.com/acme/widgets.git',
          auth,
          persist,
          "printf 'protocol=https\\nhost=github.com\\npath=acme/widgets.git\\n\\n' | git -C \"$WT\" credential fill",
        ].join("\n"),
        dir
      );
      expect(run.stderr.toString()).toBe("");
      expect(run.stdout.toString()).toContain("username=x-access-token\n");
      expect(run.stdout.toString()).toContain(`password=${token}\n`);
      const config = readFileSync(join(wt, ".git/config"), "utf8");
      expect(config).toContain("$GH_TOKEN");
      expect(config).not.toContain(token);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
