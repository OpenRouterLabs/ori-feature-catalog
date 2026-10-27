import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { parseMintArgs, resolveMintDeps } from "./mint-token.ts";
import { parseCleanupArgs } from "./cleanup-worktrees.ts";
import { parseCliArgs } from "./commit-via-api.ts";
import type { RegisterCliContext } from "./register-gh-app.ts";
import { runRegisterCli } from "./register-gh-app.ts";
import { createGhAppRegistrySchema, listApps } from "../gh-app-registry.ts";
import { Database } from "bun:sqlite";

// A single-dash token (`-repo o/r` — the typo for `--repo`) and an equals-form
// token (`--repo=o/r` — the other shell convention these CLIs never supported)
// are junk no CLI accepts: mint-token silently minted the DEFAULT App (an
// identity swap), cleanup-worktrees silently swept the DEFAULT repo (a
// wrong-target destructive sweep), and register-gh-app silently coerced
// `-purpose reviewer` into the org-level CATCH-ALL row (the #117 re-routing
// class) — while `--org=acme --app-id-key=K --private-key-key=P` parsed clean
// and failed with a "requires --org" that never named the dropped flags.
// commit-via-api.ts already failed loudly on both shapes (its pair loop reads
// `--worktree=/wt` as a flag whose value is missing); the shared guard unifies
// all four CLIs on that loud-failure contract, everywhere in argv.
describe("a single-dash token is a usage error in every value-taking CLI", () => {
  test("mint-token: -repo is rejected, not silently ignored", () => {
    // Pre-fix: {} — the typo was ignored and the DEFAULT App was minted.
    expect(parseMintArgs(["-repo", "acme/widgets"])).toEqual({
      junkArgv: "-repo",
    });
  });

  test("mint-token: an unknown --flag is refused, not silently tolerated", () => {
    // Pre-fix: the unknown flag was silently ignored (and its value token with
    // it), so a typo'd flag (`--porpose reviewer`) minted the org-level
    // CATCH-ALL App instead of the role App the caller named.
    expect(parseMintArgs(["--verbose", "--repo", "acme/widgets"])).toEqual({
      junkArgv: "--verbose",
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

describe("an equals-form --flag=value token is a usage error in every CLI", () => {
  test("mint-token: --repo=o/r is rejected, not silently ignored", () => {
    // Pre-fix: parseMintArgs(["--repo=acme/widgets", "--purpose=reviewer"])
    // returned {} — both flags silently dropped, the DEFAULT App minted.
    expect(parseMintArgs(["--repo=acme/widgets", "--purpose=reviewer"])).toEqual({
      junkArgv: "--repo=acme/widgets",
    });
  });

  test("mint-token: a value containing '=' stays accepted (only the TOKEN shape is junk)", () => {
    expect(parseMintArgs(["--repo", "acme/widgets"])).toEqual({
      targetRepo: "acme/widgets",
    });
    expect(parseMintArgs(["--purpose", "role=label"])).toEqual({
      purpose: "role=label",
    });
  });

  test("cleanup-worktrees: --repo=other/rep never silently sweeps the default repo", () => {
    // Pre-fix: parseCleanupArgs(["--repo=other/rep"], {GITHUB_REPO:"own/repo"}, "/cwd")
    // returned repo="own/repo" — the caller's target dropped, the DEFAULT repo swept.
    expect(
      parseCleanupArgs(["--repo=other/rep"], { GITHUB_REPO: "own/repo" }, "/cwd")
    ).toMatchObject({ junkArgv: "--repo=other/rep" });
  });

  test("register-gh-app: --org=acme is refused, never a misleading 'requires --org'", () => {
    // Pre-fix: exit 1 with "register requires --org, --app-id-key, and
    // --private-key-key" — a diagnostic that never named the equals-form flags
    // the caller actually passed.
    const db = new Database(":memory:");
    createGhAppRegistrySchema(db);
    const err: string[] = [];
    const code = runRegisterCli({
      argv: ["register", "--org=acme", "--app-id-key=K", "--private-key-key=P"],
      db,
      env: { K: "1", P: "2" },
      writers: { err: (t) => err.push(t), out: () => {} },
    });
    expect(code).toBe(1);
    expect(err[0] ?? "").toContain('unrecognized argument "--org=acme"');
    expect(listApps(db)).toHaveLength(0);
  });

  test("commit-via-api: the equals form keeps failing loudly (its own guard predates the shared one)", async () => {
    const outcome = await Effect.runPromise(
      parseCliArgs(
        ["--worktree=/w", "--branch=b", "--message-file=/m", "--repo=o/r"],
        { GITHUB_REPO: "owner/repo" }
      ).pipe(
        Effect.map(() => "parsed"),
        Effect.catch((error) => Effect.succeed(error.message))
      )
    );
    expect(outcome).toContain('unrecognized argument "--worktree=/w"');
  });
});
