import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import type { CommitApiError } from "./commit-via-api.ts";

import { commitViaApi } from "./commit-via-api.ts";

type Fold<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: CommitApiError };

const runFold = <A>(
  effect: Effect.Effect<A, CommitApiError>
): Promise<Fold<A>> =>
  Effect.runPromise(
    effect.pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((error) => Effect.succeed({ error, ok: false as const }))
    )
  );

describe("commitViaApi — unmerged (conflicted) worktree refusal", () => {
  test("a UU record refuses the commit with a typed error naming the path", async () => {
    let blobCreated = false;
    const fetchImpl = (url: string): Promise<Response> => {
      if (url.includes("/git/ref/heads/")) {
        return Promise.resolve(Response.json({ object: { sha: "h" } }));
      }
      if (url.includes("/git/commits/h")) {
        return Promise.resolve(Response.json({ tree: { sha: "bt" } }));
      }
      if (url.endsWith("/git/blobs")) {
        blobCreated = true;
        return Promise.resolve(Response.json({ sha: "b" }));
      }
      return Promise.resolve(Response.json({}, { status: 500 }));
    };

    const result = await runFold(
      commitViaApi(
        {
          worktree: "/tmp/wt",
          branch: "feat",
          message: "m",
          repo: "owner/repo",
        },
        {
          token: "t",
          fetchImpl,
          readFile: () => {
            throw new Error("must not be reached");
          },
          // A conflicted worktree: `git commit` refuses it; the flow must too.
          runGit: () => ({
            ok: true,
            // Real shape produced by git 2.47 on a content conflict.
            stdout: "UU f.ts\0",
            stderr: "",
          }),
        }
      )
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("nothing-to-commit");
      expect(result.error.message).toContain("unmerged");
      expect(result.error.message).toContain("f.ts");
    }
    // No blob was created for the conflicted content.
    expect(blobCreated).toBe(false);
  });

  test("a COPY-only worktree commits the destination and stages nothing for the source", async () => {
    const treeBodies: unknown[] = [];
    const fetchImpl = (url: string, init?: RequestInit): Promise<Response> => {
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

    const result = await runFold(
      commitViaApi(
        {
          worktree: "/tmp/wt",
          branch: "feat",
          message: "m",
          repo: "owner/repo",
        },
        {
          token: "t",
          fetchImpl,
          readFile: () =>
            Promise.resolve(new TextEncoder().encode("copied").buffer),
          runGit: (args: readonly string[]) =>
            args[0] === "status"
              ? // Real shape produced by git 2.47 with status.renames=copies.
                { ok: true, stdout: "C  dst.ts\0src.ts\0", stderr: "" }
              : { ok: true, stdout: "100644 abc 0\tdst.ts", stderr: "" },
        }
      )
    );

    // Pre-fix: the source field was misparsed as an add at path ".ts", so the
    // flow tried to read "<worktree>/.ts" and the whole commit failed.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("nc");
    }
    const tree = treeBodies[0] as {
      tree: Array<{ path: string; sha: string | null }>;
    };
    // Exactly one entry — the destination. The copy's source (`src.ts`) is
    // never staged, and no bogus ".ts" entry appears.
    expect(tree.tree).toHaveLength(1);
    expect(tree.tree[0]?.path).toBe("dst.ts");
    expect(tree.tree[0]?.sha).toBe("b");
  });
});
