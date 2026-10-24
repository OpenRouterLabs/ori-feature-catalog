import { describe, expect, test } from "bun:test";
import { parseMintArgs, resolveMintDeps } from "./mint-token.ts";
import { parseCleanupArgs } from "./cleanup-worktrees.ts";
import type { RegisterCliContext } from "./register-gh-app.ts";
import { runRegisterCli } from "./register-gh-app.ts";
import { createGhAppRegistrySchema, listApps } from "../gh-app-registry.ts";
import { Database } from "bun:sqlite";

// A single-dash token (`-repo o/r` — the typo for `--repo`) is junk no CLI accepts:
// mint-token silently minted the DEFAULT App (an identity swap), cleanup-worktrees
// silently swept the DEFAULT repo (a wrong-target destructive sweep), and
// register-gh-app silently coerced `-purpose reviewer` into the org-level CATCH-ALL
// row (the #117 re-routing class). commit-via-api.ts already rejects the shape.
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
});
