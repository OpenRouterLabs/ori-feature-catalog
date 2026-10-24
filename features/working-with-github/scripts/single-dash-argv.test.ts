import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { parseMintArgs, resolveMintDeps } from "./mint-token.ts";
import { parseCleanupArgs } from "./cleanup-worktrees.ts";
import { parseCliArgs } from "./commit-via-api.ts";
import type { RegisterCliContext } from "./register-gh-app.ts";
import { runRegisterCli } from "./register-gh-app.ts";
import { createGhAppRegistrySchema, listApps } from "../gh-app-registry.ts";
import { Database } from "bun:sqlite";

// A single-dash token (`-repo o/r` — the typo for `--repo`) is junk no CLI accepts:
// mint-token silently minted the DEFAULT App (an identity swap), cleanup-worktrees
// silently swept the DEFAULT repo (a wrong-target destructive sweep), and
// register-gh-app silently coerced `-purpose reviewer` into the org-level CATCH-ALL
// row (the #117 re-routing class). commit-via-api.ts joins with its own guard: its
// pair loop only rejected the KEY position, so a single-dash VALUE
// (`--branch -x`, `--repo -repo`) parsed clean and the flow minted a token and
// read `GET /git/ref/heads/-x` before failing (or committed to a branch named
// "-x"). All four CLIs now reject the shape everywhere in argv.
describe("a single-dash token is a usage error in every value-taking CLI", () => {
  test("mint-token: -repo is rejected, not silently ignored", () => {
    // Pre-fix: {} — the typo was ignored and the DEFAULT App was minted.
    expect(parseMintArgs(["-repo", "acme/widgets"])).toEqual({
      junkArgv: "-repo",
    });
  });

  test("mint-token: an unknown --flag keeps its documented tolerance", () => {
    expect(parseMintArgs(["--verbose", "--repo", "acme/widgets"])).toEqual({
      targetRepo: "acme/widgets",
    });
  });

  test("cleanup-worktrees: -repo is a usage error, never a silent default-repo sweep", () => {
    // Pre-fix: repo = "default/repo" (from GITHUB_REPO) and the sweep ran.
    expect(
      parseCleanupArgs(["-repo", "o/r", "--dry-run"], { GITHUB_REPO: "default/repo" }, "/cwd")
    ).toMatchObject({ junkArgv: "-repo" });
  });

  test("register-gh-app: -purpose is refused, never coerced to the catch-all row", () => {
    const db = new Database(":memory:");
    createGhAppRegistrySchema(db);
    const err: string[] = [];
    const code = runRegisterCli({
      argv: ["register", "-purpose", "reviewer", "--org", "acme", "--app-id-key", "K", "--private-key-key", "P"],
      db,
      env: { K: "1", P: "2" },
      writers: { err: (t) => err.push(t), out: () => {} },
    });
    expect(code).toBe(1);
    expect(err[0] ?? "").toContain("unrecognized argument");
    expect(listApps(db)).toHaveLength(0);
  });

  test("commit-via-api: a single-dash VALUE is rejected at the parse, before any mint or blob", async () => {
    // Pre-fix: parse succeeded with branch "-x" (the pair loop's key-position
    // guard never saw the VALUE slot), and the flow went on to mint a token
    // and read the ref for a branch literally named "-x".
    const outcome = await Effect.runPromise(
      parseCliArgs(
        ["--worktree", "/w", "--branch", "-x", "--message-file", "/m"],
        { GITHUB_REPO: "owner/repo" }
      ).pipe(
        Effect.map(() => "parsed"),
        Effect.catch((error) => Effect.succeed(error.message))
      )
    );
    expect(outcome).toContain('unrecognized argument "-x"');

    const repoSlot = await Effect.runPromise(
      parseCliArgs(
        ["--repo", "-repo", "--worktree", "/w", "--branch", "b", "--message-file", "/m"],
        { GITHUB_REPO: "owner/repo" }
      ).pipe(
        Effect.map(() => "parsed"),
        Effect.catch((error) => Effect.succeed(error.message))
      )
    );
    expect(repoSlot).toContain('unrecognized argument "-repo"');
  });

  test("commit-via-api: a plain value containing a dash inside stays accepted", async () => {
    // The guard is on the token SHAPE, not its content: `fix-x` branch names
    // and /tmp paths are the normal case and must keep parsing.
    const parsed = await Effect.runPromise(
      parseCliArgs(
        ["--worktree", "/tmp/worktrees/owner-repo/fix-x", "--branch", "fix-x", "--message-file", "/tmp/msg"],
        { GITHUB_REPO: "owner/repo" }
      )
    );
    expect(parsed.branch).toBe("fix-x");
  });
});
