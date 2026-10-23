import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { commitViaApi } from "./commit-flow.ts";

// A REAL repo reproduces the symlink staging divergence between the flow and
// `git add`:
//
//   git add <link>          → index row mode 120000, blob = the link-target
//                              string (readlink, NOT the target's bytes)
//   pre-fix buildTreeEntry  → readFile() follows the link → mode 100644 with
//                            the TARGET's content — or ENOENT for a dangling
//                            link, failing the whole commit
//
// The comment on the flow claims "the flow is worktree-sync: it commits ` M`
// worktree-only modifies too … mirrors what `git add -A` stages", but
// symlinks — a first-class tree entry in every repo, checked out as links by
// git itself — were read as regular files. A committed symlink became a
// REGULAR FILE with the target's bytes: cloning the repo no longer
// reconstructs the link, and a `git add` on the same worktree shows the file
// as type-changed (`T`) — the commit diverges from git's own state.

/** Collect the (mode, blob-content) pairs the flow sends for the tree. */
interface SentBlob {
  readonly content: string;
  readonly encoding: string;
}

const runCommit = async (
  worktree: string,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
): Promise<
  {
    ok: true;
    blobs: SentBlob[];
    tree: { path: string; mode: string; type: string }[];
  } | { ok: false; message: string; stage: string }
> => {
  const blobs: SentBlob[] = [];
  let tree: { path: string; mode: string; type: string }[] | undefined;
  const fold = await Effect.runPromise(
    commitViaApi(
      { worktree, branch: "main", message: "m", repo: "owner/repo" },
      {
        fetchImpl,
        readFile: (p) => Bun.file(p).arrayBuffer(),
        token: "TOK",
      }
    ).pipe(
      Effect.match({
        onFailure: (error) => ({
          ok: false as const,
          message: error.message,
          stage: error.stage,
        }),
        onSuccess: () => ({ ok: true as const }),
      })
    )
  );
  return fold.ok
    ? { ok: true, blobs, tree: tree ?? [] }
    : fold;
};

/** Fake Git-Data-API capturing blob bodies and the tree POST. Handles both
 *  `/git/commits` call shapes: the GET (head commit → base tree) and the
 *  POST (create commit). */
const makeCapturingFetch = (
  blobs: SentBlob[],
  onTree: (t: { path: string; mode: string; type: string }[]) => void
): ((url: string, init?: RequestInit) => Promise<Response>) => {
  return (url, init) => {
    if (url.endsWith("/git/blobs")) {
      const body = JSON.parse(init?.body as string) as SentBlob;
      blobs.push(body);
      return Promise.resolve(Response.json({ sha: "blob" }));
    }
    if (url.endsWith("/git/trees")) {
      onTree(JSON.parse(init?.body as string).tree);
      return Promise.resolve(Response.json({ sha: "tree" }));
    }
    // The head-commit GET is `/git/commits/{sha}`; the create is a POST to
    // `/git/commits` — match on the path segment, then branch on method.
    if (url.includes("/git/commits")) {
      if (init?.method === "POST") return Promise.resolve(Response.json({ sha: "commit" }));
      return Promise.resolve(Response.json({ tree: { sha: "bt" } }));
    }
    if (url.includes("/git/ref/heads/")) {
      return Promise.resolve(Response.json({ object: { sha: "commit" } }));
    }
    return Promise.resolve(Response.json({}));
  };
};

describe("commitViaApi — symbolic links", () => {
  test("a NEWLY ADDED symlink stages as mode 120000 with the link target as its blob content, matching `git add`", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wwg-symlink-"));
    try {
      execFileSync("git", ["init", "-q", "."], { cwd: dir });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "root"], {
        cwd: dir,
      });
      const target = join(dir, "target.txt");
      writeFileSync(target, "target-content");
      symlinkSync("target.txt", join(dir, "link.sh"));
      // The oracle: what `git add` stages for the same worktree.
      const gitAddMode = execFileSync(
        "bash",
        [
          "-c",
          `cd "${dir}" && git add link.sh >/dev/null 2>&1 && git ls-files --stage link.sh | cut -d' ' -f1`,
        ],
        { encoding: "utf-8" }
      ).trim();
      expect(gitAddMode).toBe("120000");
      // Restore the untracked state for the flow.
      execFileSync("git", ["rm", "--cached", "-q", "link.sh"], { cwd: dir });

      const blobs: SentBlob[] = [];
      let tree: { path: string; mode: string; type: string }[] = [];
      const result = await runCommit(
        dir,
        makeCapturingFetch(blobs, (t) => {
          tree = t;
        })
      );
      expect(result.ok).toBe(true);
      const link = (tree as { path: string; mode: string }[]).find(
        (e) => e.path === "link.sh"
      );
      expect(link).toBeDefined();
      expect(link?.mode).toBe("120000"); // pre-fix: 100644
      // The blob content is the link-target STRING, not the target's bytes
      // ("target-content" pre-fix, "target.txt" post-fix).
      const linkBlob = blobs[0];
      expect(linkBlob.encoding).toBe("utf-8");
      expect(linkBlob.content).toBe("target.txt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a DANGLING symlink still commits (git stores the target string; it does not dereference)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wwg-symlink-dangling-"));
    try {
      execFileSync("git", ["init", "-q", "."], { cwd: dir });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "root"], {
        cwd: dir,
      });
      // The target does NOT exist — git still stores the string, and so must
      // the flow. Pre-fix, Bun.file() on the dangling link ENOENTs and the
      // whole commit fails with "could not read <path>: ENOENT", blaming a
      // path that exists as a symlink.
      symlinkSync("../never-created.txt", join(dir, "dead.sh"));
      const blobs: SentBlob[] = [];
      let tree: { path: string; mode: string }[] = [];
      const result = await runCommit(
        dir,
        makeCapturingFetch(blobs, (t) => {
          tree = t;
        })
      );
      expect(result.ok).toBe(true); // pre-fix: ok:false, ENOENT
      const link = (tree as { path: string; mode: string }[]).find(
        (e) => e.path === "dead.sh"
      );
      expect(link?.mode).toBe("120000");
      expect(blobs[0]?.content).toBe("../never-created.txt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// A self-contained unit repro (no disk) pinning the readLink seam contract:
// buildTreeEntry must route a symlink through readLink, never readFile.
describe("commitViaApi — the readLink seam", () => {
  test("a symlink never goes through readFile (the target's bytes must not leak into the commit)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wwg-symlink-seam-"));
    try {
      execFileSync("git", ["init", "-q", "."], { cwd: dir });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "root"], {
        cwd: dir,
      });
      symlinkSync("x.txt", join(dir, "l.txt"));
      const readFiles: string[] = [];
      const readLinks: string[] = [];
      await Effect.runPromise(
        commitViaApi(
          { worktree: dir, branch: "main", message: "m", repo: "o/r" },
          {
            fetchImpl: (url, init) => {
              if (url.endsWith("/git/blobs")) {
                return Promise.resolve(Response.json({ sha: "b" }));
              }
              if (url.endsWith("/git/trees")) {
                return Promise.resolve(Response.json({ sha: "t" }));
              }
              if (url.endsWith("/git/commits") && init?.method === "POST") {
                return Promise.resolve(Response.json({ sha: "c" }));
              }
              if (url.includes("/git/commits/")) {
                return Promise.resolve(Response.json({ tree: { sha: "bt" } }));
              }
              if (url.includes("/git/ref/heads/")) {
                return Promise.resolve(Response.json({ object: { sha: "c" } }));
              }
              return Promise.resolve(Response.json({}));
            },
            readFile: (p) => {
              readFiles.push(p);
              return Bun.file(p).arrayBuffer();
            },
            readLink: async (p) => {
              readLinks.push(p);
              return "x.txt";
            },
            token: "TOK",
          }
        )
      );
      expect(readLinks.length).toBe(1);
      expect(readFiles).toEqual([]); // pre-fix: readFile was called on the link
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** mkdirSync wrapper for the seam test's mkdtemp-free variant. */
function mkdtempSync(prefix: string): string {
  const dir = join(tmpdir(), `${prefix.replace(/[/\\:]/g, "_")}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
