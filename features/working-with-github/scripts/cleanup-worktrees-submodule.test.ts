import { afterEach, describe, expect, test } from "bun:test";

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { cleanupWorktrees } from "./cleanup-worktrees-core.ts";

// `git worktree remove` refuses ANY worktree with a populated submodule,
// clean or not ("fatal: working trees containing submodules cannot be moved
// or removed"); only `--force` removes one. Pre-fix the sweep reported that
// refusal as an error on every daily run, so a clean worktree whose PR had
// closed was never reclaimed once its submodule was initialized. The sweep
// now forces the removal, but only when the tree is clean with submodule
// changes counted and every submodule's HEAD is on one of its remotes: the
// worktree's submodule repos live under its own git dir, so a forced removal
// deletes a submodule commit that was never pushed.

const GIT_ENV = {
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_AUTHOR_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "protocol.file.allow",
  GIT_CONFIG_VALUE_0: "always",
};

const git = (args: readonly string[], cwd: string): string => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
};

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

/** A checkout with a submodule, and a `fix-sub` worktree whose submodule is
 *  initialized, under the sweep's slug layout. */
const fixture = () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "wwg-submodule-")));
  scratch.push(work);
  const sub = join(work, "sub");
  git(["init", "-q", "-b", "main", sub], work);
  writeFileSync(join(sub, "f.txt"), "one\n");
  git(["add", "."], sub);
  git(["commit", "-q", "-m", "sub"], sub);
  const checkout = join(work, "checkout");
  git(["init", "-q", "-b", "main", checkout], work);
  git(["submodule", "add", "-q", sub, "sub"], checkout);
  git(["commit", "-q", "-m", "init"], checkout);
  const root = join(work, "worktrees");
  const wt = join(root, "acme-widgets", "fix-sub");
  git(["worktree", "add", "-q", wt, "-b", "fix-sub", "main"], checkout);
  git(["submodule", "update", "--init", "-q"], wt);
  const head = git(["rev-parse", "HEAD"], wt);
  return { checkout, head, root, wt };
};

const sweep = (input: {
  readonly checkout: string;
  readonly root: string;
  readonly headSha: string;
}) =>
  Effect.runPromise(
    cleanupWorktrees(
      {
        fetchImpl: () =>
          Promise.resolve(
            Response.json([
              { head: { sha: input.headSha }, number: 42, state: "closed" },
            ])
          ),
        token: "tok",
      },
      {
        dryRun: false,
        repo: "acme/widgets",
        repoDir: input.checkout,
        repoSlug: "acme-widgets",
        worktreesRoot: input.root,
      }
    )
  );

describe("the sweep retires a clean worktree with an initialized submodule", () => {
  test("a clean worktree whose submodule HEAD is on its remote is removed", async () => {
    const { checkout, head, root, wt } = fixture();
    const summary = await sweep({ checkout, headSha: head, root });
    const outcome = summary.outcomes.find((entry) => entry.path === wt);
    expect(outcome?.detail).toBe("removed (PR #42 closed, tree clean)");
    expect(outcome?.decision).toBe("removed");
    expect(git(["worktree", "list", "--porcelain"], checkout)).not.toContain(wt);
    expect(git(["branch", "--list", "fix-sub"], checkout)).toBe("");
  });

  test("a submodule commit on no remote keeps the worktree", async () => {
    const { checkout, head, root, wt } = fixture();
    git(["checkout", "-q", "--detach"], join(wt, "sub"));
    git(["commit", "-q", "--allow-empty", "-m", "local only"], join(wt, "sub"));
    git(["add", "sub"], wt);
    git(["commit", "-q", "-m", "bump"], wt);
    const bumped = git(["rev-parse", "HEAD"], wt);
    expect(bumped).not.toBe(head);
    const summary = await sweep({ checkout, headSha: bumped, root });
    const outcome = summary.outcomes.find((entry) => entry.path === wt);
    expect(outcome?.decision).toBe("error");
    expect(outcome?.detail).toContain("containing submodules");
    expect(outcome?.detail).toContain("submodule commits on no remote: sub");
    expect(git(["worktree", "list", "--porcelain"], checkout)).toContain(wt);
  });

  test("a dirty submodule keeps the worktree", async () => {
    const { checkout, head, root, wt } = fixture();
    writeFileSync(join(wt, "sub", "f.txt"), "edited\n");
    const summary = await sweep({ checkout, headSha: head, root });
    const outcome = summary.outcomes.find((entry) => entry.path === wt);
    expect(outcome?.decision).not.toBe("removed");
    expect(git(["worktree", "list", "--porcelain"], checkout)).toContain(wt);
  });

  test("a submodule set to ignore=all still has its dirt counted", async () => {
    const { checkout, head, root, wt } = fixture();
    git(["config", "submodule.sub.ignore", "all"], wt);
    writeFileSync(join(wt, "sub", "f.txt"), "edited\n");
    expect(git(["status", "--porcelain"], wt)).toBe("");
    const summary = await sweep({ checkout, headSha: head, root });
    const outcome = summary.outcomes.find((entry) => entry.path === wt);
    expect(outcome?.decision).toBe("error");
    expect(git(["worktree", "list", "--porcelain"], checkout)).toContain(wt);
  });
});
