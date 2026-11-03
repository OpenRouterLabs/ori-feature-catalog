import { afterEach, describe, expect, test } from "bun:test";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Step 7 of the change flow ended with a bare `git worktree remove "$WT"`.
// That keeps the worktree's local branch, so the next run of the flow with
// the same branch name died at step 1 (`git worktree add "$WT" -b
// branch-name` → "a branch named 'branch-name' already exists"), and the
// cleanup sweep the skill points at cannot help: it only visits worktrees,
// never a branch left behind by one already removed. Step 2 also leaves the
// shell INSIDE the worktree, and every git command run from a deleted
// directory fails, so a plain `git branch -D` added after the remove would
// fail too. Step 7 now leaves for the checkout, removes the worktree, and
// deletes its branch.

const prompt = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "prompt.md"),
  "utf-8"
);

const fences = [...prompt.matchAll(/```bash[^\n]*\n([\s\S]*?)```/g)].map(
  (match) => match[1] ?? ""
);

/** Step 1's worktree-creating line and step 7's cleanup lines, comments and
 *  GitHub calls dropped: the part of the flow that runs on local git alone. */
const commandsOf = (fence: string, keep: (line: string) => boolean): string =>
  fence
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .filter(keep)
    .join("\n");

const stepOne = fences.find((fence) => fence.includes("git worktree add")) ?? "";
const stepSeven =
  fences.find((fence) => fence.includes("git worktree remove")) ?? "";

const addLine = commandsOf(stepOne, (line) =>
  line.startsWith("git worktree add")
);
const cleanupLines = commandsOf(
  stepSeven,
  (line) => !line.includes("gh api") && !line.startsWith("--jq")
);

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

const GIT_ENV = {
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_AUTHOR_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
};

const bash = (script: string, cwd: string) =>
  Bun.spawnSync(["bash", "-ec", script], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    stderr: "pipe",
    stdout: "pipe",
  });

/** How the checkout the worktree is cut from keeps its git dir: a plain clone
 *  (`<checkout>/.git`), a submodule (the superproject's `.git/modules/<name>`,
 *  the vendored-upstream layout), or a `--separate-git-dir` clone. */
type CheckoutLayout = "plain" | "submodule" | "separate-git-dir";

const checkoutScript = (
  layout: CheckoutLayout,
  work: string,
  checkout: string
): string => {
  if (layout === "plain") {
    return [
      `git init -q -b main "${checkout}"`,
      `cd "${checkout}"`,
      "git commit -q --allow-empty -m init",
    ].join("\n");
  }
  const upstream = join(work, "upstream");
  const seed = [
    `git init -q -b main "${upstream}"`,
    `git -C "${upstream}" commit -q --allow-empty -m init`,
  ];
  if (layout === "separate-git-dir") {
    return [
      ...seed,
      `mkdir -p "${join(work, "gitdirs")}"`,
      `git clone -q --separate-git-dir="${join(work, "gitdirs", "upstream.git")}" "${upstream}" "${checkout}"`,
    ].join("\n");
  }
  const superproject = join(work, "super");
  return [
    ...seed,
    `git init -q -b main "${superproject}"`,
    `cd "${superproject}"`,
    `git -c protocol.file.allow=always submodule add -q "${upstream}" vendor/upstream`,
    "git commit -q -m vendor",
    `ln -s "${join(superproject, "vendor", "upstream")}" "${checkout}"`,
  ].join("\n");
};

/** A checkout plus one worktree cut by step 1, with the shell left inside the
 *  worktree the way step 2 (`cd "$WT"`) leaves it. */
const flowFixture = (layout: CheckoutLayout = "plain") => {
  const work = mkdtempSync(join(tmpdir(), "wwg-step7-"));
  scratch.push(work);
  const checkout = join(work, "checkout");
  const wt = join(work, "worktrees", "acme-widgets", "fix-typo");
  const init = bash(checkoutScript(layout, work, checkout), work);
  expect(init.stderr.toString()).not.toContain("fatal");
  expect(init.exitCode).toBe(0);
  const add = (cwd: string) =>
    bash(
      `WT="${wt}"\n${addLine
        .replaceAll("branch-name", "fix-typo")
        .replaceAll("FETCH_HEAD", "main")}`,
      cwd
    );
  return { add, checkout, wt };
};

describe("step 7 leaves the flow re-runnable under the same branch name", () => {
  test("the recipe lines were found", () => {
    expect(addLine).toContain('git worktree add "$WT" -b branch-name');
    expect(cleanupLines).toContain('git worktree remove "$WT"');
  });

  test("step 7 deletes the worktree's branch, run from inside the worktree", () => {
    const { add, checkout, wt } = flowFixture();
    expect(add(checkout).exitCode).toBe(0);
    const cleanup = bash(
      `WT="${wt}"\n${cleanupLines.replaceAll("branch-name", "fix-typo")}`,
      wt
    );
    expect(cleanup.stderr.toString()).not.toContain("fatal");
    expect(cleanup.exitCode).toBe(0);
    const branches = bash("git branch --list fix-typo", checkout);
    expect(branches.stdout.toString().trim()).toBe("");
    expect(add(checkout).exitCode).toBe(0);
  });

  test("a bare `git worktree remove` (the old step 7) blocks the next run", () => {
    const { add, checkout, wt } = flowFixture();
    expect(add(checkout).exitCode).toBe(0);
    expect(bash(`git worktree remove "${wt}"`, wt).exitCode).toBe(0);
    const again = add(checkout);
    expect(again.exitCode).not.toBe(0);
    expect(again.stderr.toString()).toContain("already exists");
  });
});

// Step 7 used to `cd` to the PARENT of the common git dir. That is the
// checkout only for a plain clone. A worktree cut from a submodule checkout
// (a vendored upstream clone) or a `--separate-git-dir` clone sent the shell
// outside the repository, and `git worktree remove` failed ("is not a working
// tree" from a superproject's `.git/modules/`, "not a git repository"
// elsewhere): the worktree and its branch both stayed, and the next run under
// the same name died at step 1.
describe("step 7 works wherever the checkout keeps its git dir", () => {
  for (const layout of ["submodule", "separate-git-dir"] as const) {
    test(`a worktree cut from a ${layout} checkout is removed with its branch`, () => {
      const { add, checkout, wt } = flowFixture(layout);
      expect(add(checkout).exitCode).toBe(0);
      const cleanup = bash(
        `WT="${wt}"\n${cleanupLines.replaceAll("branch-name", "fix-typo")}`,
        wt
      );
      expect(cleanup.stderr.toString()).not.toContain("fatal");
      expect(cleanup.exitCode).toBe(0);
      expect(bash("git worktree list", checkout).stdout.toString()).not.toContain(
        wt
      );
      const branches = bash("git branch --list fix-typo", checkout);
      expect(branches.stdout.toString().trim()).toBe("");
      expect(add(checkout).exitCode).toBe(0);
    });

    test(`the old parent-dir step 7 fails on a ${layout} checkout`, () => {
      const { add, checkout, wt } = flowFixture(layout);
      expect(add(checkout).exitCode).toBe(0);
      const old = bash(
        [
          `WT="${wt}"`,
          'cd "$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir)/.."',
          'git worktree remove "$WT" && git branch -D fix-typo',
        ].join("\n"),
        wt
      );
      expect(old.exitCode).not.toBe(0);
      expect(old.stderr.toString()).toContain("fatal");
    });
  }
});
