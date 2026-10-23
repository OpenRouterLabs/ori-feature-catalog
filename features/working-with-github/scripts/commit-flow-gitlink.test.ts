import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { commitViaApi } from "./commit-flow.ts";

// A REAL repo reproduces the directory/gitlink staging divergence between the
// flow and `git add`:
//
//   git add <dir-with-nested-repo> → index row mode 160000 (a gitlink commit
//                                    pointer); the tree entry is
//                                    { mode: "160000", type: "commit" }
//   pre-fix buildTreeEntry         → readFile() on a directory rejects
//                                    ("Directories cannot be read like files")
//                                    and the WHOLE run fails — every sibling
//                                    file change is lost too
//
// A dirty submodule (` M sub` — the porcelain record for a tracked gitlink
// whose nested repo moved) hit the same readFile() path with no trailing
// slash to hint at it. `git add -A && git commit` records the gitlink's new
// HEAD sha; the flow must build the same entry, or skip (a plain untracked
// directory git did not descend into) rather than fail.

interface TreeEntrySent {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly sha?: string;
}

interface CommitRun {
  readonly ok: boolean;
  readonly stage?: string;
  readonly message?: string;
  readonly tree: TreeEntrySent[];
}

const runCommit = async (worktree: string): Promise<CommitRun> => {
  const tree: TreeEntrySent[] = [];
  const fold = await Effect.runPromise(
    commitViaApi(
      { worktree, branch: "main", message: "m", repo: "owner/repo" },
      {
        fetchImpl: (url: string, init?: RequestInit): Promise<Response> => {
          if (url.endsWith("/git/blobs")) {
            return Promise.resolve(Response.json({ sha: "blob" }));
          }
          if (url.endsWith("/git/trees") && init?.method === "POST") {
            tree.push(
              ...(
                JSON.parse(String(init.body)) as {
                  tree: TreeEntrySent[];
                }
              ).tree
            );
            return Promise.resolve(Response.json({ sha: "tree" }));
          }
          if (url.includes("/git/commits")) {
            if (init?.method === "POST") {
              return Promise.resolve(Response.json({ sha: "commit" }));
            }
            return Promise.resolve(Response.json({ tree: { sha: "bt" } }));
          }
          if (url.includes("/git/ref/heads/")) {
            return Promise.resolve(Response.json({ object: { sha: "c" } }));
          }
          return Promise.resolve(Response.json({}));
        },
        token: "TOK",
      }
    ).pipe(
      Effect.match({
        onFailure: (error) => ({
          ok: false as const,
          stage: error.stage,
          message: error.message,
        }),
        onSuccess: () => ({ ok: true as const }),
      })
    )
  );
  return fold.ok
    ? { ok: true, tree }
    : {
        ok: false,
        stage: fold.stage,
        message: fold.message,
        tree,
      };
};

/** A real repo with a base commit and one tracked file; the nested repo is
 *  created by the test. */
const withRepo = async (
  run: (dir: string) => Promise<void>
): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "wwg-gitlink-"));
  try {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("bash", ["-c", `cd "${dir}" && echo base > base.txt && git add base.txt`]);
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "root"], {
      cwd: dir,
    });
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("commitViaApi — directories and gitlinks", () => {
  test("a dirty tracked gitlink ( M sub) stages as a 160000 commit entry, not a blob read", async () =>
    withRepo(async (dir) => {
      // An embedded repo, staged so the index row is mode 160000.
      execFileSync("git", ["init", "-q", "sub"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "t@t"], {
        cwd: join(dir, "sub"),
      });
      execFileSync("git", ["config", "user.name", "t"], {
        cwd: join(dir, "sub"),
      });
      execFileSync("bash", ["-c", `cd "${join(dir, "sub")}" && echo x > f && git add f && git commit -qm s`]);
      execFileSync("git", ["add", "sub"], { cwd: dir });
      // The oracle: what `git add -A` stages after the nested repo moves.
      execFileSync("bash", [
        "-c",
        `cd "${join(dir, "sub")}" && echo y >> f && git commit -qam s2 && cd "${dir}" && git add -A`,
      ]);
      const gitMode = execFileSync("git", ["ls-files", "--stage", "sub"], {
        cwd: dir,
        encoding: "utf-8",
      })
        .trim()
        .split(/\s+/)[0];
      expect(gitMode).toBe("160000");
      const expectedSha = execFileSync(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: join(dir, "sub"), encoding: "utf-8" }
      ).trim();

      const result = await runCommit(dir);
      // Pre-fix: ok:false, "could not read sub: Directories cannot be read
      // like files" — the whole run failed.
      expect(result.ok).toBe(true);
      const entry = result.tree.find((e) => e.path === "sub");
      expect(entry).toBeDefined();
      expect(entry?.mode).toBe("160000");
      expect(entry?.type).toBe("commit");
      expect(entry?.sha).toBe(expectedSha);
    }));

  test("an untracked directory holding a nested git repo (?? tools/) is staged as a 160000 gitlink, exactly like `git add -A`, not read as a file", async () =>
    withRepo(async (dir) => {
      execFileSync("bash", [
        "-c",
        `mkdir -p "${join(dir, "tools")}" && cd "${join(dir, "tools")}" && git init -q . && git config user.email t@t && git config user.name t && echo t > f && git add f && git commit -qm t`,
      ]);
      // The oracle: what `git add -A` stages for the same worktree — a 160000
      // gitlink row pointing at the nested repo's HEAD.
      const expectedSha = execFileSync(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: join(dir, "tools"), encoding: "utf-8" }
      ).trim();
      execFileSync("bash", ["-c", `cd "${dir}" && echo change >> base.txt`]);

      const result = await runCommit(dir);
      // Pre-fix (v1): ok:false, "could not read tools/: Directories cannot be
      // read like files". Pre-fix (v2): the `?? tools/` record was dropped at
      // the parse, so the commit landed with NO entry for the nested repo —
      // a silent divergence from `git add -A`.
      expect(result.ok).toBe(true);
      // A 160000 gitlink commit entry at the slash-stripped path, pointing at
      // the nested repo's HEAD — the entry `git add -A` stages.
      const entry = result.tree.find((e) => e.path === "tools");
      expect(entry?.mode).toBe("160000");
      expect(entry?.type).toBe("commit");
      expect(entry?.sha).toBe(expectedSha);
      // The sibling file change is still committed.
      expect(result.tree.length).toBeGreaterThan(0);
    }));

  test("a nested git repo with an unborn HEAD (?? tools/, no commit yet) refuses the run — `git add -A` refuses this worktree, so the flow must not land a green commit that ignores the path", async () =>
    withRepo(async (dir) => {
      // A nested repo with nothing committed: `git rev-parse HEAD` fails,
      // and there is no index row to fall back to.
      execFileSync("bash", [
        "-c",
        `mkdir -p "${join(dir, "tools")}" && cd "${join(dir, "tools")}" && git init -q . && git config user.email t@t && git config user.name t`,
      ]);
      execFileSync("bash", ["-c", `cd "${dir}" && echo change >> base.txt`]);
      // The oracle: `git add -A` refuses the whole worktree —
      // "error: 'tools/' does not have a commit checked out / fatal: adding
      // files failed", exit 128. A `git commit` on this tree is impossible.
      const addAll = spawnSync(
        "bash",
        ["-c", `cd "${dir}" && git add -A`],
        { encoding: "utf-8" }
      );
      expect(addAll.status).not.toBe(0);
      expect(String(addAll.stderr)).toContain("does not have a commit checked out");

      const result = await runCommit(dir);
      // Pre-fix: ok:true with NO entry for tools — a green Verified commit
      // that silently ignored the nested repo `git add -A` refuses on.
      expect(result.ok).toBe(false);
      expect(result.stage).toBe("git");
      expect(result.message).toContain("tools");
      expect(result.message).toContain("no commit checked out");
      // Nothing was staged — the flow failed before any tree was sent.
      expect(result.tree).toEqual([]);
    }));

  test("a plain untracked directory IS descended into — its files stage normally", async () =>
    withRepo(async (dir) => {
      // The counter-case: `--untracked-files=all` DOES flatten a plain
      // directory into per-file records, so its files must stage as normal
      // blobs — only a directory git does not descend into (a nested repo)
      // yields a trailing-slash record.
      execFileSync("bash", ["-c", `mkdir -p "${join(dir, "plain")}" && echo t > "${join(dir, "plain", "x")}"`]);
      const result = await runCommit(dir);
      expect(result.ok).toBe(true);
      const entry = result.tree.find((e) => e.path === "plain/x");
      expect(entry).toBeDefined();
      expect(entry?.mode).toBe("100644");
    }));
});
