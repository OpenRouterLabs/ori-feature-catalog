import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { commitViaApi } from "./commit-flow.ts";

// A REAL repo reproduces the stale-gitlink staging divergence between the
// flow and `git add`:
//
//   worktree state        ` M sub` — the submodule advanced inside its nested
//                         repo, but the bump was never `git add`-ed in the
//                         superproject, so the index row still holds the OLD
//                         commit sha while the nested repo's HEAD has moved.
//   `git add -A` stages   the gitlink at the nested repo's NEW HEAD.
//   pre-fix flow          read the index row FIRST and staged the STALE sha —
//                         a silent divergence from `git add -A && git commit`
//                         on the same worktree, landing a Verified commit
//                         that points the submodule at a superseded commit.
//
// The sibling commit-flow-gitlink.test.ts fixture runs `git add -A` before
// the flow, which re-stages the index row at the nested repo's new HEAD and
// masks exactly this state; this fixture leaves the bump UNSTAGED, the shape
// a real worktree is in when commit-via-api is invoked.

interface TreeEntrySent {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly sha?: string;
}

const runCommit = async (worktree: string): Promise<TreeEntrySent[]> => {
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
        onFailure: () => ({ ok: false as const }),
        onSuccess: () => ({ ok: true as const }),
      })
    )
  );
  expect(fold.ok).toBe(true);
  return tree;
};

describe("commitViaApi — a bumped-but-unstaged submodule stages the nested repo's NEW HEAD", () => {
  test("` M sub` with the bump never `git add`-ed in the superproject stages sub's new HEAD, not the stale index row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wwg-gitlink-stale-"));
    try {
      const sh = (script: string): void => {
        execFileSync("bash", ["-c", `cd "${dir}" && ${script}`]);
      };
      // Base: a superproject whose index already holds the gitlink at sub's
      // FIRST commit (the stale-from-here row).
      sh(
        "git init -q . && git config user.email t@t && git config user.name t"
      );
      sh(
        "git init -q sub && cd sub && git config user.email t@t && git config user.name t && echo x > f && git add f && git commit -qm first"
      );
      sh("git add sub && git commit -qm base");
      // The bump: sub advances, and the superproject does NOT stage it.
      sh(
        "cd sub && echo y >> f && git commit -qam second"
      );
      const porcelain = execFileSync(
        "bash",
        ["-c", `cd "${dir}" && git status --porcelain=v1 -z --untracked-files=all`],
        { encoding: "utf-8" }
      );
      expect(porcelain).toBe(" M sub\0");

      const newHead = execFileSync(
        "bash",
        ["-c", `cd "${dir}/sub" && git rev-parse HEAD`],
        { encoding: "utf-8" }
      ).trim();
      // The oracle: what `git add -A` stages for the gitlink. A temp index
      // (GIT_INDEX_FILE) runs the staging WITHOUT touching the repo's real
      // index, and without any copy: the pre-fix oracle `cp -a`-ed the whole
      // tree to a FIXED path (`/tmp/wwg-oracle-$$`, nothing ever removed it —
      // 29 stray trees observed; a naive `.oracle` sibling is worse still:
      // concurrent runs share the path, and a leftover copy makes `cp` nest
      // INTO it so `ls-files -- sub` reads the wrong sha — reproduced). The
      // temp index is unique per run, lives only for these two commands, and
      // needs no cleanup beyond `rm -f`.
      const oracleSha = execFileSync(
        "bash",
        [
          "-c",
          `cd "${dir}" && IDX=$(mktemp -u) && GIT_INDEX_FILE="$IDX" git read-tree HEAD && GIT_INDEX_FILE="$IDX" git add -A && GIT_INDEX_FILE="$IDX" git ls-files --stage -- sub | awk '{print $2}'; rm -f "$IDX"`,
        ],
        { encoding: "utf-8" }
      ).trim();
      expect(oracleSha).toBe(newHead);

      const tree = await runCommit(dir);
      const entry = tree.find((e) => e.path === "sub");
      expect(entry).toBeDefined();
      expect(entry?.mode).toBe("160000");
      expect(entry?.type).toBe("commit");
      // Pre-fix: the STALE index sha (sub's first commit) — a Verified commit
      // silently pointing the submodule at a superseded commit.
      expect(entry?.sha).toBe(newHead);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
