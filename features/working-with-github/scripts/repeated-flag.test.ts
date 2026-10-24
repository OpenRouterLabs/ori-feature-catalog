import { describe, expect, test } from "bun:test";
// A repeated value-taking flag is a paste error, and before this suite the
// four CLIs each silently picked a winner — a DIFFERENT one per CLI:
//
// - `mint-token.ts --repo acme/a --repo acme/b` minted for `acme/a`
//   (`argv.indexOf` → first occurrence wins);
// - `cleanup-worktrees.ts --repo acme/a --repo acme/b` swept `acme/a`
//   (same `indexOf` first-wins in `readFlag`);
// - `register-gh-app.ts register --org acme --org other …` persisted `acme`
//   (same `readFlag`);
// - `commit-via-api.ts --repo acme/a --repo acme/b …` committed to `acme/b`
//   (the pair loop writes into a `Map`, so the LAST occurrence wins).
//
// The dangerous combination is mint-token + commit-via-api in one shell: a
// pasted command block with a duplicated `--repo` mints the token for the
// FIRST repo and lands the Verified commit on the SECOND — a cross-repo
// identity mismatch with no diagnostic, the same silent-wrong-target class
// the single-dash (#155) and equals-form (#162/#165) guards closed for the
// shapes a shell actually produces.
//
// The shared contract this suite pins: a repeated value-taking flag is a
// usage error in every CLI, naming the flag — never a silent winner.
import { Effect } from "effect";

import { parseCliArgs } from "./commit-via-api.ts";
import { parseCleanupArgs } from "./cleanup-worktrees.ts";
import { parseMintArgs } from "./mint-token.ts";
import type { RegisterCliContext } from "./register-gh-app.ts";
import { runRegisterCli } from "./register-gh-app.ts";
import { createGhAppRegistrySchema, listApps } from "../gh-app-registry.ts";
import { Database } from "bun:sqlite";

describe("a repeated value-taking flag is a usage error in every CLI", () => {
  // ─── mint-token.ts ────────────────────────────────────────────────────────

  test("mint-token: a repeated --repo is refused, never a silent first-wins", () => {
    // Pre-fix: {"targetRepo":"acme/a"} — the second value silently dropped.
    expect(parseMintArgs(["--repo", "acme/a", "--repo", "acme/b"])).toEqual({
      repeatedFlag: "--repo",
    });
  });

  test("mint-token: a repeated --org (the --repo alias) is refused too", () => {
    // Reported under the canonical --repo name: --org is its alias.
    expect(parseMintArgs(["--org", "acme-a", "--org", "acme-b"])).toEqual({
      repeatedFlag: "--repo",
    });
  });

  test("mint-token: a repeated --purpose is refused", () => {
    expect(
      parseMintArgs(["--repo", "acme/a", "--purpose", "x", "--purpose", "y"])
    ).toEqual({
      repeatedFlag: "--purpose",
    });
  });

  test("mint-token: --repo and its --org alias together are a repeat, not an override", () => {
    // `--repo acme/a --org acme-b` names the target twice through two
    // spellings; first-wins silently dropped the second before.
    expect(parseMintArgs(["--repo", "acme/a", "--org", "acme-b"])).toEqual({
      repeatedFlag: "--repo",
    });
    expect(parseMintArgs(["--org", "acme-b", "--repo", "acme/a"])).toEqual({
      repeatedFlag: "--repo",
    });
  });

  test("mint-token: an unrepeated flag keeps parsing unchanged", () => {
    expect(parseMintArgs(["--repo", "acme/a", "--purpose", "reviewer"])).toEqual(
      {
        purpose: "reviewer",
        targetRepo: "acme/a",
      }
    );
  });

  // ─── cleanup-worktrees.ts ─────────────────────────────────────────────────

  test("cleanup-worktrees: a repeated --repo is refused, never a silent first-wins", () => {
    // Pre-fix: repo "acme/a" — the sweep targeted the FIRST repo while the
    // caller may have meant the second (a wrong-target destructive sweep).
    const parsed = parseCleanupArgs(
      ["--repo", "acme/a", "--repo", "acme/b"],
      {},
      "/cwd"
    );
    expect(parsed.repeatedFlag).toBe("--repo");
  });

  test("cleanup-worktrees: repeated --repo-dir and --worktrees-root are refused too", () => {
    expect(
      parseCleanupArgs(
        ["--repo-dir", "/a", "--repo-dir", "/b", "--repo", "o/r"],
        {},
        "/cwd"
      ).repeatedFlag
    ).toBe("--repo-dir");
    expect(
      parseCleanupArgs(
        ["--worktrees-root", "/a", "--worktrees-root", "/b", "--repo", "o/r"],
        {},
        "/cwd"
      ).repeatedFlag
    ).toBe("--worktrees-root");
  });

  test("cleanup-worktrees: an unrepeated parse keeps its shape", () => {
    expect(
      parseCleanupArgs(["--repo", "o/r"], { GITHUB_REPO: "x/y" }, "/cwd")
    ).toEqual({
      dryRun: false,
      repo: "o/r",
      repoDir: "/cwd",
      worktreesRoot: "/tmp/worktrees",
    });
  });

  // ─── register-gh-app.ts ───────────────────────────────────────────────────

  test("register-gh-app: a repeated --org is refused, never a silent first-wins", () => {
    // Pre-fix: exit 0 persisting org "acme" — the second value silently
    // dropped, re-routing every future mint for it.
    const db = new Database(":memory:");
    createGhAppRegistrySchema(db);
    const err: string[] = [];
    const code = runRegisterCli({
      argv: [
        "register",
        "--org",
        "acme",
        "--org",
        "other",
        "--app-id-key",
        "K",
        "--private-key-key",
        "P",
      ],
      db,
      env: { K: "1", P: "2" },
      writers: {
        err: (t) => {
          err.push(t);
        },
        out: () => {},
      },
    });
    expect(code).toBe(1);
    expect(err[0]).toContain("--org");
    expect(listApps(db)).toEqual([]);
  });

  test("register-gh-app: repeated --purpose / --app-id-key / --private-key-key are refused", () => {
    const cases: readonly (readonly string[])[] = [
      ["--org", "acme", "--purpose", "x", "--purpose", "y"],
      ["--org", "acme", "--app-id-key", "K", "--app-id-key", "K2"],
      ["--org", "acme", "--private-key-key", "P", "--private-key-key", "P2"],
    ];
    for (const argv of cases) {
      const db = new Database(":memory:");
      createGhAppRegistrySchema(db);
      const err: string[] = [];
      const code = runRegisterCli({
        argv: ["register", ...argv],
        db,
        env: { K: "1", P: "2", K2: "1", P2: "2" },
        writers: {
          err: (t) => {
            err.push(t);
          },
          out: () => {},
        },
      });
      expect(code).toBe(1);
      expect(err[0]).toContain("more than once");
      expect(listApps(db)).toEqual([]);
    }
  });

  // ─── commit-via-api.ts ────────────────────────────────────────────────────

  test("commit-via-api: a repeated --repo is refused, never a silent last-wins", async () => {
    // Pre-fix: parsed clean and committed to "acme/b" (Map.set last-wins)
    // while mint-token minted for "acme/a" — the cross-repo mismatch.
    const outcome = await Effect.runPromise(
      parseCliArgs(
        [
          "--repo",
          "acme/a",
          "--repo",
          "acme/b",
          "--worktree",
          "/w",
          "--branch",
          "br",
          "--message-file",
          "/m",
        ],
        { GITHUB_REPO: "x/y" }
      ).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (value) => ({ ok: true as const, value }),
        })
      )
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.stage).toBe("args");
      expect(outcome.error.message).toContain("--repo");
      expect(outcome.error.message).toContain("more than once");
    }
  });

  test("commit-via-api: a repeated --branch is refused too", async () => {
    const outcome = await Effect.runPromise(
      parseCliArgs(
        [
          "--worktree",
          "/w",
          "--branch",
          "a",
          "--branch",
          "b",
          "--message-file",
          "/m",
        ],
        { GITHUB_REPO: "x/y" }
      ).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (value) => ({ ok: true as const, value }),
        })
      )
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.message).toContain("--branch");
    }
  });

  test("commit-via-api: an unrepeated parse keeps its shape", async () => {
    const parsed = await Effect.runPromise(
      parseCliArgs(
        ["--worktree", "/w", "--branch", "br", "--message-file", "/m"],
        { GITHUB_REPO: "x/y" }
      )
    );
    expect(parsed).toEqual({
      branch: "br",
      messageFile: "/m",
      repo: "x/y",
      worktree: "/w",
    });
  });
});
