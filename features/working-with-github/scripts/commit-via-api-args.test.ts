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

describe("parseStatusZ", () => {
  test("parses adds, modifies, and deletes", () => {
    // `XY␠path` records joined by NUL.
    const out = `${["A  features/a.ts", " M features/b.ts", "D  features/c.ts"].join("\0")}\0`;
    expect(parseStatusZ(out)).toEqual([
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
  });

  test("treats a rename as old-path delete + new-path add", () => {
    const out = "R  new.ts\0old.ts\0";
    expect(parseStatusZ(out)).toEqual([
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
    expect(parseStatusZ("")).toEqual([]);
    expect(parseStatusZ("\0\0")).toEqual([]);
  });

  test("keeps paths containing spaces intact (NUL-delimited)", () => {
    const out = "A  features/with space.ts\0";
    expect(parseStatusZ(out)).toEqual([
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
});
