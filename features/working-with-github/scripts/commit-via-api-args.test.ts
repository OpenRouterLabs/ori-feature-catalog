import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import type { CommitApiError } from "./commit-via-api.ts";

import {
  parseCliArgs,
  parseStatusZ,
  resolveRepoFromEnv,
} from "./commit-via-api.ts";

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

describe("resolveRepoFromEnv", () => {
  test("returns a bare owner/repo unchanged", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: "owner/repo" })).toBe(
      "owner/repo"
    );
  });

  test("extracts owner/repo from a full https URL and strips .git", () => {
    expect(
      resolveRepoFromEnv({ GITHUB_REPO: "https://github.com/owner/repo.git" })
    ).toBe("owner/repo");
  });

  test("returns empty string when GITHUB_REPO is unset", () => {
    expect(resolveRepoFromEnv({})).toBe("");
  });
});

describe("parseCliArgs --repo spellings", () => {
  test("a URL-shaped --repo is normalized, not passed through to the Git Data API route", async () => {
    // Pre-fix: `--repo https://github.com/owner/repo.git` was used verbatim,
    // so every call hit `/repos/https://github.com/owner/repo.git/git/ref/...`
    // and 404'd — while `GITHUB_REPO` accepted the same URL spelling.
    const outcome = await runFold(
      parseCliArgs([
        "--repo",
        "https://github.com/owner/repo.git",
        "--branch",
        "b",
        "--message-file",
        "/tmp/msg",
        "--worktree",
        "/tmp/wt",
      ])
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.repo).toBe("owner/repo");
    }
  });

  test("a bare owner/repo --repo passes through unchanged", async () => {
    const outcome = await runFold(
      parseCliArgs([
        "--repo",
        "owner/repo",
        "--branch",
        "b",
        "--message-file",
        "/tmp/msg",
        "--worktree",
        "/tmp/wt",
      ])
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.repo).toBe("owner/repo");
    }
  });

  test("a trailing slash on --repo is normalized away, not 404'd by every Git Data route", async () => {
    // Pre-fix: `owner/repo/` sailed through unchanged; every
    // `https://api.github.com/repos/owner/repo//git/...` route answers 404
    // (doubled slash), so the whole signed-commit flow died at the ref
    // read. A copy-pasted address-bar repo string is the common case.
    const outcome = await runFold(
      parseCliArgs([
        "--repo",
        "owner/repo/",
        "--branch",
        "b",
        "--message-file",
        "/tmp/msg",
        "--worktree",
        "/tmp/wt",
      ])
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.repo).toBe("owner/repo");
    }
  });
});

describe("parseStatusZ", () => {
  test("parses adds, modifies, and deletes", () => {
    // `XY␠path` records joined by NUL.
    const out = `${["A  features/a.ts", " M features/b.ts", "D  features/c.ts"].join("\0")}\0`;
    expect(parseStatusZ(out).changed).toEqual([
      {
        path: "features/a.ts",
        deleted: false,
      },
      {
        path: "features/b.ts",
        deleted: false,
      },
      {
        path: "features/c.ts",
        deleted: true,
      },
    ]);
    expect(parseStatusZ(out).unmerged).toEqual([]);
  });

  test("treats a rename as old-path delete + new-path add", () => {
    const out = "R  new.ts\0old.ts\0";
    expect(parseStatusZ(out).changed).toEqual([
      {
        path: "old.ts",
        deleted: true,
      },
      {
        path: "new.ts",
        deleted: false,
      },
    ]);
  });

  test("ignores empty trailing fields", () => {
    expect(parseStatusZ("")).toEqual({ changed: [], unmerged: [] });
    expect(parseStatusZ("\0\0")).toEqual({ changed: [], unmerged: [] });
  });

  test("keeps paths containing spaces intact (NUL-delimited)", () => {
    const out = "A  features/with space.ts\0";
    expect(parseStatusZ(out).changed).toEqual([
      {
        path: "features/with space.ts",
        deleted: false,
      },
    ]);
  });
});

describe("parseCliArgs", () => {
  test("parses required flags and defaults the repo from GITHUB_REPO", async () => {
    const result = await runFold(
      parseCliArgs(
        [
          "--worktree",
          "/tmp/wt",
          "--branch",
          "feat",
          "--message-file",
          "/tmp/m",
        ],
        {
          GITHUB_REPO: "owner/repo",
        }
      )
    );
    expect(result).toEqual({
      ok: true,
      value: {
        worktree: "/tmp/wt",
        branch: "feat",
        messageFile: "/tmp/m",
        repo: "owner/repo",
      },
    });
  });

  test("honours an explicit --repo over GITHUB_REPO", async () => {
    const result = await runFold(
      parseCliArgs(
        [
          "--worktree",
          "/tmp/wt",
          "--branch",
          "feat",
          "--message-file",
          "/tmp/m",
          "--repo",
          "owner/other",
        ],
        {
          GITHUB_REPO: "owner/repo",
        }
      )
    );
    expect(result.ok && result.value.repo).toBe("owner/other");
  });

  test("fails when a required flag is missing", async () => {
    const result = await runFold(
      parseCliArgs(["--worktree", "/tmp/wt"], { GITHUB_REPO: "owner/repo" })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("args");
    }
  });

  test("fails when neither --repo nor GITHUB_REPO is set", async () => {
    const result = await runFold(
      parseCliArgs(
        [
          "--worktree",
          "/tmp/wt",
          "--branch",
          "feat",
          "--message-file",
          "/tmp/m",
        ],
        {}
      )
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("args");
      expect(result.error.message).toContain("GITHUB_REPO");
    }
  });

  test("rejects a flag-shaped value instead of accepting it as garbage (mirrors the sibling CLIs)", async () => {
    // Pre-fix: `--branch --worktree` parsed OK with branch "--worktree" —
    // the flow then 404s `GET /git/ref/heads/--worktree` AFTER creating
    // blobs, or commits to a branch that literally carries the flag name.
    // `mint-token.ts`, `register-gh-app.ts` and `cleanup-worktrees.ts` all
    // reject a flag-shaped value at parse time; this CLI must too.
    const result = await runFold(
      parseCliArgs(
        [
          "--worktree",
          "/tmp/wt",
          "--branch",
          "--worktree",
          "--message-file",
          "/tmp/m",
        ],
        { GITHUB_REPO: "owner/repo" }
      )
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("args");
      expect(result.error.message).toContain("--branch");
    }
  });

  test("rejects an empty flag value at the parse, before any network side effect", async () => {
    // Pre-fix: `--branch ""` parsed clean and the flow failed LATE — after
    // minting a token and creating blobs, on a 404 from
    // `GET /git/ref/heads/` — while `mint-token.ts` fails the same shape at
    // the parse (#98/#107). The message must name the flag.
    const result = await runFold(
      parseCliArgs(
        [
          "--worktree",
          "/tmp/wt",
          "--branch",
          "",
          "--message-file",
          "/tmp/m",
        ],
        { GITHUB_REPO: "owner/repo" }
      )
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("args");
      expect(result.error.message).toContain("--branch");
      expect(result.error.message).toContain("empty");
    }
    // A whitespace-only value is the same class.
    const whitespace = await runFold(
      parseCliArgs(
        [
          "--worktree",
          "/tmp/wt",
          "--branch",
          "  ",
          "--message-file",
          "/tmp/m",
        ],
        { GITHUB_REPO: "owner/repo" }
      )
    );
    expect(whitespace.ok).toBe(false);
  });

  test("trims a padded flag value instead of passing it through raw", async () => {
    // Pre-fix: `--branch " fix-x "` parsed clean with the padding intact and
    // the flow failed LATE — a 404 from `GET /git/ref/heads/ fix-x ` after
    // minting a token and creating blobs (or worse, a commit to a branch
    // that literally carries the spaces). The sibling CLIs
    // (`mint-token.ts`, `register-gh-app.ts`) trim their value-taking flags;
    // this CLI must too.
    const result = await runFold(
      parseCliArgs(
        [
          "--worktree",
          " /tmp/wt ",
          "--branch",
          " fix-x ",
          "--message-file",
          " /tmp/m ",
        ],
        { GITHUB_REPO: "owner/repo" }
      )
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        branch: "fix-x",
        messageFile: "/tmp/m",
        repo: "owner/repo",
        worktree: "/tmp/wt",
      });
    }
  });
});
