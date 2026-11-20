import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { commitViaApi } from "./commit-flow.ts";

// GitHub refuses a GitHub App token without the `workflows` permission any
// tree that writes under .github/workflows/: the member's token under
// --as member is an App user token, and so is an installation token from an
// App that was never granted it. The answer is a bare 403 "Resource not
// accessible by integration" (live on OpenRouterLabs/ori-feature-catalog,
// 2026-11-20: the same credential committed probe/x.txt on the same branch a
// minute later). Read under the prompt's denial rule, that reads as "this
// credential does not reach the repository", so the error has to say which
// paths GitHub refused and why.

const runCommit = async (files: Record<string, string>, treeStatus: number) => {
  const dir = await mkdtemp(join(tmpdir(), "wwg-workflows-"));
  try {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    return await Effect.runPromise(
      commitViaApi(
        { worktree: dir, branch: "probe", message: "m", repo: "owner/repo" },
        {
          fetchImpl: (url) => {
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
              return Promise.resolve(
                Response.json(
                  {
                    message: "Resource not accessible by integration",
                    status: String(treeStatus),
                  },
                  { status: treeStatus }
                )
              );
            }
            return Promise.resolve(Response.json({}));
          },
          readFile: (p) => Bun.file(p).arrayBuffer(),
          asMember: true,
          warn: () => undefined,
        }
      ).pipe(
        Effect.match({
          onFailure: (error) => error.message,
          onSuccess: () => "committed",
        })
      )
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("commitViaApi — a tree GitHub refuses for a workflow file", () => {
  test("a 403 on a tree that writes .github/workflows names the paths and the workflows permission", async () => {
    const message = await runCommit(
      { ".github/workflows/ci.yml": "name: ci\n", "src/a.txt": "a\n" },
      403
    );
    expect(message).toContain("Resource not accessible by integration");
    expect(message).toContain(".github/workflows/ci.yml");
    expect(message).toContain("`workflows` permission");
    expect(message).not.toContain("src/a.txt");
  });

  test("a 403 on a tree with no workflow file keeps GitHub's own message alone", async () => {
    const message = await runCommit({ "src/a.txt": "a\n" }, 403);
    expect(message).toContain("Resource not accessible by integration");
    expect(message).not.toContain("workflows");
  });

  test("another failure on a workflow tree is not blamed on the permission", async () => {
    const message = await runCommit({ ".github/workflows/ci.yml": "x\n" }, 422);
    expect(message).not.toContain("`workflows` permission");
  });
});
