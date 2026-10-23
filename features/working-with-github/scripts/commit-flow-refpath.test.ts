import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { commitViaApi } from "./commit-flow.ts";

// The branch name goes into TWO Git-Data-API ref routes as path segments:
//
//   GET   /repos/{repo}/git/ref/heads/{branch}
//   PATCH /repos/{repo}/git/refs/heads/{branch}
//
// GitHub routes the branch as PATH SEGMENTS (`a/b` → `…/heads/a/b`) and
// answers 404 for a `%2F`-encoded slash (the same behavior the go-gh team
// fixed in cli/cli#10049; go-github documents that branch names in repo
// paths must not contain escaped `/`). `encodeURIComponent` encodes the
// slash, so pre-fix EVERY slash-bearing branch — including the feature
// prompt's own documented convention `WT=/tmp/worktrees/$SLUG/branch-name`,
// `git worktree add -b branch-name` with any `fix/<topic>` name — failed the
// ref lookup with 404 and the flow aborted before staging anything.
//
// `#` and `?` must still be encoded (fragment/query delimiters), so the fix
// re-decodes only `%2F`.

describe("commitViaApi — branch names in the ref routes", () => {
  test("a slash-bearing branch hits the ref routes with unencoded slashes and encoded reserved characters", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wwg-refpath-"));
    try {
      execFileSync("git", ["init", "-q", "."], { cwd: dir });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "root"], {
        cwd: dir,
      });
      execFileSync("bash", [
        "-c",
        `echo hi > "${join(dir, "f.txt")}"`,
      ]);
      const refUrls: string[] = [];
      const result = await Effect.runPromise(
        commitViaApi(
          {
            worktree: dir,
            // `#` exercises the still-encoded half; `/` the un-encoded half.
            branch: "fix/slash-bearer-#1",
            message: "m",
            repo: "owner/repo",
          },
          {
            fetchImpl: (url, init) => {
              if (url.includes("/git/ref/heads/") || url.includes("/git/refs/heads/")) {
                refUrls.push(`${init?.method ?? "GET"} ${url}`);
              }
              if (url.includes("/git/ref/heads/")) {
                return Promise.resolve(Response.json({ object: { sha: "h" } }));
              }
              if (url.includes("/git/commits/")) {
                return Promise.resolve(Response.json({ tree: { sha: "bt" } }));
              }
              if (url.endsWith("/git/blobs")) {
                return Promise.resolve(Response.json({ sha: "b" }));
              }
              if (url.endsWith("/git/trees")) {
                return Promise.resolve(Response.json({ sha: "t" }));
              }
              if (url.endsWith("/git/commits")) {
                return Promise.resolve(Response.json({ sha: "c" }));
              }
              return Promise.resolve(Response.json({}));
            },
            readFile: (p) => Bun.file(p).arrayBuffer(),
            token: "TOK",
          }
        ).pipe(
          Effect.match({
            onFailure: (error) => ({
              ok: false as const,
              message: error.message,
            }),
            onSuccess: () => ({ ok: true as const }),
          })
        )
      );
      expect(result.ok).toBe(true);
      expect(refUrls.length).toBe(2);
      const [read, patch] = refUrls;
      // Slash stays a literal path separator…
      expect(read).toContain("/git/ref/heads/fix/slash-bearer-%231");
      expect(patch).toContain("/git/refs/heads/fix/slash-bearer-%231");
      // …and never the %2F form GitHub 404s on.
      expect(read).not.toContain("%2F");
      expect(patch).not.toContain("%2F");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
