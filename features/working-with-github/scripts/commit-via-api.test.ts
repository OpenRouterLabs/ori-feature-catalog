import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import type { CommitApiError } from "./commit-via-api.ts";

import { commitViaApi } from "./commit-via-api.ts";

type Fold<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: CommitApiError };

/**
 * Fold both Effect channels into a plain tagged object so assertions can branch
 * on success vs failure without `Effect.runPromise` throwing.
 */
const runFold = <A>(
  effect: Effect.Effect<A, CommitApiError>
): Promise<Fold<A>> =>
  Effect.runPromise(
    effect.pipe(
      Effect.map((value) => ({
        ok: true as const,
        value,
      })),
      Effect.catch((error) =>
        Effect.succeed({
          ok: false as const,
          error,
        })
      )
    )
  );

/** Parse a fetch init body, which our code always sends as a JSON string. */
const parseBody = (body: RequestInit["body"]): unknown =>
  typeof body === "string" ? JSON.parse(body) : undefined;

interface FakeRunGitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** A fake `runGit` keyed on the first arg, so a test scripts git's responses. */
const fakeRunGit =
  (
    responses: Record<
      string,
      { ok?: boolean; stdout?: string; stderr?: string }
    >
  ) =>
  (args: readonly string[]): FakeRunGitResult => {
    const key = args[0] ?? "";
    const r = responses[key] ?? {};
    return {
      ok: r.ok ?? true,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  };

/** True if `value` looks like a `{ tree: TreeEntry[] }` body — used to narrow the
 *  captured request body in the "deleted file" test below. */
const isTreeBody = (
  value: unknown
): value is {
  tree: { path: string; mode: string; type: string; sha: string | null }[];
} =>
  typeof value === "object" &&
  value !== null &&
  "tree" in value &&
  Array.isArray((value as Record<string, unknown>).tree);

/** A fetch that 404s the branch-ref lookup and 200s everything else — drives the
 *  "surfaces a GitHub HTTP error" path. Module-scoped so it is not recreated per call. */
const httpErrorFetch = (url: string): Promise<Response> => {
  if (url.includes("/git/ref/heads/")) {
    return Promise.resolve(
      Response.json({ message: "Not Found" }, { status: 404 })
    );
  }
  return Promise.resolve(Response.json({}, { status: 200 }));
};

describe("commitViaApi", () => {
  test("drives blobs→tree→commit→ref and returns the new commit sha", async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const fetchImpl = (url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      const body = parseBody(init?.body);
      calls.push({
        method,
        url,
        body,
      });
      if (url.includes("/git/ref/heads/")) {
        return Promise.resolve(Response.json({ object: { sha: "headsha" } }));
      }
      if (url.includes("/git/commits/headsha")) {
        return Promise.resolve(Response.json({ tree: { sha: "basetree" } }));
      }
      if (url.endsWith("/git/blobs")) {
        return Promise.resolve(Response.json({ sha: "blobsha" }));
      }
      if (url.endsWith("/git/trees")) {
        return Promise.resolve(Response.json({ sha: "newtree" }));
      }
      if (url.endsWith("/git/commits")) {
        return Promise.resolve(Response.json({ sha: "newcommit" }));
      }
      if (url.includes("/git/refs/heads/")) {
        return Promise.resolve(Response.json({ object: { sha: "newcommit" } }));
      }
      return Promise.resolve(
        Response.json({ message: "unexpected" }, { status: 500 })
      );
    };

    const result = await runFold(
      commitViaApi(
        {
          worktree: "/tmp/wt",
          branch: "feat",
          message: "msg",
          repo: "owner/repo",
        },
        {
          token: "injected-token",
          fetchImpl,
          readFile: () =>
            Promise.resolve(new TextEncoder().encode("hello").buffer),
          runGit: fakeRunGit({
            status: { stdout: "M  features/a.ts\0" },
            "ls-files": { stdout: "100644 abc 0\tfeatures/a.ts" },
          }),
        }
      )
    );

    expect(result).toEqual({
      ok: true,
      value: "newcommit",
    });
    // The commit must be created with the right tree + parent — that POST is
    // what GitHub signs.
    const commitCall = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/git/commits")
    );
    expect(commitCall?.body).toEqual({
      message: "msg",
      tree: "newtree",
      parents: ["headsha"],
    });
    // Auth must use the injected token (no minting attempted).
    // (No /access_tokens call should appear.)
    expect(calls.some((c) => c.url.includes("/access_tokens"))).toBe(false);
  });

  test("stages a deleted file as a null-sha tree entry (no blob created)", async () => {
    let blobCreated = false;
    let treeBody: unknown;
    const fetchImpl = (url: string, init?: RequestInit): Promise<Response> => {
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
      if (url.endsWith("/git/trees")) {
        treeBody = parseBody(init?.body);
        return Promise.resolve(Response.json({ sha: "nt" }));
      }
      if (url.endsWith("/git/commits")) {
        return Promise.resolve(Response.json({ sha: "nc" }));
      }
      if (url.includes("/git/refs/heads/")) {
        return Promise.resolve(Response.json({ object: { sha: "nc" } }));
      }
      return Promise.resolve(
        Response.json({ message: "unexpected" }, { status: 500 })
      );
    };

    const result = await runFold(
      commitViaApi(
        {
          worktree: "/tmp/wt",
          branch: "feat",
          message: "rm",
          repo: "owner/repo",
        },
        {
          token: "t",
          fetchImpl,
          runGit: fakeRunGit({ status: { stdout: "D  gone.ts\0" } }),
        }
      )
    );

    expect(result.ok).toBe(true);
    expect(blobCreated).toBe(false);
    if (!isTreeBody(treeBody)) {
      throw new Error("expected a tree body");
    }
    const entries = treeBody.tree;
    expect(entries).toEqual([
      {
        path: "gone.ts",
        mode: "100644",
        type: "blob",
        sha: null,
      },
    ]);
  });

  test("fails with a typed error when there is nothing to commit", async () => {
    const result = await runFold(
      commitViaApi(
        {
          worktree: "/tmp/wt",
          branch: "feat",
          message: "noop",
          repo: "owner/repo",
        },
        {
          token: "t",
          fetchImpl: () => Promise.reject(new Error("should not be called")),
          runGit: fakeRunGit({ status: { stdout: "" } }),
        }
      )
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("nothing-to-commit");
    }
  });

  test("a malformed sha on a created object fails stage:parse naming the field", async () => {
    const fetchImpl = (url: string): Promise<Response> => {
      if (url.includes("/git/ref/heads/")) {
        return Promise.resolve(Response.json({ object: { sha: "headsha" } }));
      }
      if (url.includes("/git/commits/headsha")) {
        return Promise.resolve(Response.json({ tree: { sha: "basetree" } }));
      }
      if (url.endsWith("/git/blobs")) {
        return Promise.resolve(Response.json({ sha: 42 }));
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
          readFile: () => Promise.resolve(new TextEncoder().encode("x").buffer),
          runGit: fakeRunGit({ status: { stdout: "M  a.ts\0" } }),
        }
      )
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("parse");
      expect(result.error.message).toContain("sha");
      expect(result.error.message).toContain("Expected string");
      expect(result.error.message).toContain("/git/blobs");
    }
  });

  test("a branch ref missing its nested sha names the whole path", async () => {
    const fetchImpl = (url: string): Promise<Response> => {
      if (url.includes("/git/ref/heads/")) {
        return Promise.resolve(Response.json({ object: {} }));
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
          readFile: () => Promise.resolve(new TextEncoder().encode("x").buffer),
          runGit: fakeRunGit({ status: { stdout: "M  a.ts\0" } }),
        }
      )
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("parse");
      expect(result.error.message).toContain("object");
      expect(result.error.message).toContain("sha");
    }
  });

  test("unknown extra fields on every Git-Data response are tolerated", async () => {
    // Real GitHub bodies carry far more than the flow reads (url, node_id,
    // author, verification, ...). Adding a field must never break a commit.
    const noise = {
      node_id: "MDQ6",
      some_field_added_next_year: true,
      url: "https://api.github.com/whatever",
    };
    const fetchImpl = (url: string): Promise<Response> => {
      if (url.includes("/git/ref/heads/")) {
        return Promise.resolve(
          Response.json({
            ...noise,
            object: {
              sha: "headsha",
              type: "commit",
            },
            ref: "refs/heads/feat",
          })
        );
      }
      if (url.includes("/git/commits/headsha")) {
        return Promise.resolve(
          Response.json({
            ...noise,
            author: { name: "someone" },
            tree: { sha: "basetree" },
            verification: { verified: true },
          })
        );
      }
      if (url.endsWith("/git/blobs")) {
        return Promise.resolve(Response.json({ ...noise, sha: "blobsha" }));
      }
      if (url.endsWith("/git/trees")) {
        return Promise.resolve(
          Response.json({
            ...noise,
            sha: "newtree",
            tree: [],
          })
        );
      }
      if (url.endsWith("/git/commits")) {
        return Promise.resolve(Response.json({ ...noise, sha: "newcommit" }));
      }
      if (url.includes("/git/refs/heads/")) {
        return Promise.resolve(
          Response.json({ ...noise, ref: "refs/heads/feat" })
        );
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
          readFile: () => Promise.resolve(new TextEncoder().encode("x").buffer),
          runGit: fakeRunGit({
            status: { stdout: "M  a.ts\0" },
            "ls-files": { stdout: "100644 x 0\ta.ts" },
          }),
        }
      )
    );
    expect(result).toEqual({
      ok: true,
      value: "newcommit",
    });
  });

  test("surfaces a GitHub HTTP error with its status", async () => {
    const result = await runFold(
      commitViaApi(
        {
          worktree: "/tmp/wt",
          branch: "missing",
          message: "m",
          repo: "owner/repo",
        },
        {
          token: "t",
          fetchImpl: httpErrorFetch,
          readFile: () => Promise.resolve(new TextEncoder().encode("x").buffer),
          runGit: fakeRunGit({
            status: { stdout: "M  a.ts\0" },
            "ls-files": { stdout: "100644 x 0\ta.ts" },
          }),
        }
      )
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("http");
      expect(result.error.status).toBe(404);
    }
  });
});
