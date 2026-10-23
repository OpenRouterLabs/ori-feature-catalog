import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { commitViaApi } from "./commit-flow.ts";

// A REAL repo with `core.fileMode=false` (a checkout on a filesystem without
// real permission bits — Windows/CIFS/FAT) reproduces a staging divergence
// between the flow and `git add`:
//
//   git add run.sh        → index row mode 100644  (git IGNORES the exec bit)
//   isExecutable()        → reads the raw disk bit  → 100755
//
// The comment on `isExecutable` claims "Mirrors git's own rule for what
// `git add` stages", but git's rule for a NEWLY ADDED file in a
// core.fileMode=false repo is the disk bit with fileMode tracking OFF — i.e.
// always 100644. The pre-fix flow read the disk bit for untracked files in
// every repo, committing 100755 where `git add` (and the branch's own history)
// carry 100644. On a CIFS checkout every file on disk reads as executable,
// so EVERY newly added file was committed 100755.

describe("commitViaApi — exec-bit staging in a core.fileMode=false repo", () => {
  test("a newly added file in a core.fileMode=false repo commits as 100644, mirroring `git add`", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wwg-filemode-"));
    try {
      execFileSync("git", ["init", "-q", "."], { cwd: dir });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      execFileSync("git", ["config", "core.fileMode", "false"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "root"], {
        cwd: dir,
      });
      // A newly added file with the exec bit set on disk.
      const scriptPath = join(dir, "run.sh");
      execFileSync("bash", [
        "-c",
        `echo hi > "${scriptPath}" && chmod +x "${scriptPath}"`,
      ]);
      // What `git add` would stage in this repo — the oracle:
      const gitAddMode = execFileSync(
        "bash",
        ["-c", `cd "${dir}" && git add run.sh >/dev/null 2>&1; git ls-files --stage run.sh | cut -d' ' -f1`],
        { encoding: "utf-8" }
      ).trim();
      expect(gitAddMode).toBe("100644"); // git ignores the exec bit here
      // Restore the pre-add state so the flow sees a genuinely UNTRACKED file
      // (the `git add` above was only the staging oracle).
      execFileSync("git", ["rm", "--cached", "-q", "run.sh"], { cwd: dir });

      const treeBodies: Array<{
        tree: Array<{ path: string; mode: string }>;
      }> = [];
      const fetchImpl = (
        url: string,
        init?: RequestInit
      ): Promise<Response> => {
        if (url.includes("/git/ref/heads/")) {
          return Promise.resolve(Response.json({ object: { sha: "h" } }));
        }
        if (url.includes("/git/commits/h")) {
          return Promise.resolve(Response.json({ tree: { sha: "bt" } }));
        }
        if (url.endsWith("/git/blobs")) {
          return Promise.resolve(Response.json({ sha: "b" }));
        }
        if (url.endsWith("/git/trees")) {
          treeBodies.push(
            typeof init?.body === "string" ? JSON.parse(init.body) : undefined
          );
          return Promise.resolve(Response.json({ sha: "nt" }));
        }
        if (url.endsWith("/git/commits")) {
          return Promise.resolve(Response.json({ sha: "nc" }));
        }
        return Promise.resolve(Response.json({ object: { sha: "nc" } }));
      };

      const outcome = await Effect.runPromise(
        commitViaApi(
          {
            branch: "b",
            message: "m",
            repo: "owner/repo",
            worktree: dir,
          },
          {
            fetchImpl,
            token: "t",
          }
        )
      ).then(
        (sha) => ({ ok: true as const, sha }),
        (error) => ({ ok: false as const, error: String(error) })
      );

      expect(outcome.ok).toBe(true);
      const tree = treeBodies[0];
      // The flow must stage the same mode `git add` stages: 100644.
      expect(tree.tree[0]?.mode).toBe("100644");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
