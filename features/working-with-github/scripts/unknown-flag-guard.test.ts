import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect } from "effect";

import { parseCliArgs } from "./commit-via-api.ts";
import { parseCleanupArgs } from "./cleanup-worktrees.ts";
import { createGhAppRegistrySchema, listApps } from "../gh-app-registry.ts";
import { runRegisterCli } from "./register-gh-app.ts";

// An unknown `--`-flag in argv is a usage error in EVERY value-taking CLI,
// never a silently-dropped token that eats its value: mint-token.ts already
// refuses the shape (its `findUnknownFlag` guard), and `--porpose reviewer`
// there fails loudly. The other three CLIs only rejected the single-dash
// and equals-form shapes (`findJunkArgv`) — a WELL-formed but unknown flag
// (`--porpose reviewer`, `--dryrun`, `--mesage-file /x`) parsed clean, its
// value token vanished with it, and the caller's intent silently routed
// somewhere else:
//   - register-gh-app: `--porpose reviewer` exited 0 and landed the row
//     under the org-level CATCH-ALL (`default`) — re-routing every future
//     mint without --purpose to the App the other flags named (#117's
//     class, reopened through the typo'd flag);
//   - cleanup-worktrees: `--dryrun` silently parsed as a REAL sweep —
//     `dryRun: false` — and the destructive path ran with no dry-run guard
//     the caller believed they had;
//     and `--repro o/r` silently swept the DEFAULT repo's slug directory;
//   - commit-via-api: `--mesage-file /x` silently committed the message
//     from `--message-file /m` (or failed late with a missing-file
//     diagnostic) — the typo'd flag's value never reached the flow.
// One guard, four CLIs: the unknown well-formed flag is refused with the
// token named, exactly like the single-dash and equals-form shapes.
describe("an unknown --flag is a usage error in every value-taking CLI", () => {
  test("register-gh-app: --porpose reviewer is refused, never coerced to the catch-all row", () => {
    const db = new Database(":memory:");
    createGhAppRegistrySchema(db);
    const err: string[] = [];
    const code = runRegisterCli({
      argv: [
        "register",
        "--porpose",
        "reviewer",
        "--org",
        "acme",
        "--app-id-key",
        "K",
        "--private-key-key",
        "P",
      ],
      db,
      env: { K: "1", P: "2" },
      writers: { err: (t) => err.push(t), out: () => {} },
    });
    // Pre-fix: exit 0, confirmation on stdout, and the row persisted under
    // purpose "default" — the caller asked for a reviewer-role App and
    // silently re-routed every future mint without --purpose.
    expect(code).toBe(1);
    expect(err[0] ?? "").toContain("unrecognized argument");
    expect(err[0] ?? "").toContain("--porpose");
    expect(listApps(db)).toHaveLength(0);
  });

  test("register-gh-app list: an unknown flag is refused too, never a silent full listing", () => {
    const db = new Database(":memory:");
    createGhAppRegistrySchema(db);
    const err: string[] = [];
    const out: string[] = [];
    const code = runRegisterCli({
      argv: ["list", "--verbos"],
      db,
      env: {},
      writers: { err: (t) => err.push(t), out: (t) => out.push(t) },
    });
    expect(code).toBe(1);
    expect(err[0] ?? "").toContain("unrecognized argument");
    expect(out).toHaveLength(0);
  });

  test("cleanup-worktrees: --dryrun parses as a REAL sweep, never a silent dry-run-off", () => {
    // Pre-fix: dryRun stayed false — the caller believed they had a dry run
    // and the sweep went on to remove worktrees.
    const args = parseCleanupArgs(
      ["--dryrun"],
      { GITHUB_REPO: "acme/widgets" },
      "/cwd"
    );
    expect(args).toMatchObject({ junkArgv: "--dryrun", dryRun: false });
  });

  test("cleanup-worktrees: --repro o/r never silently sweeps the default repo", () => {
    // Pre-fix: the unknown flag's value token vanished with it and the sweep
    // ran against the DEFAULT repo (GITHUB_REPO) — the wrong-target
    // destructive-sweep class the repeated-flag guard closes for `--repo`.
    const args = parseCleanupArgs(
      ["--repro", "other/rep", "--dry-run"],
      { GITHUB_REPO: "acme/widgets" },
      "/cwd"
    );
    expect(args).toMatchObject({ junkArgv: "--repro" });
  });

  test("commit-via-api: --mesage-file /x is refused, its value never vanishes", async () => {
    // Pre-fix: parsed clean — messageFile stayed "/m" and the flow minted a
    // token and read the ref before failing (or committed) with the typo'd
    // flag's value never read.
    const outcome = await Effect.runPromise(
      parseCliArgs(
        [
          "--worktree",
          "/w",
          "--branch",
          "br",
          "--message-file",
          "/m",
          "--mesage-file",
          "/x",
        ],
        { GITHUB_REPO: "owner/repo" }
      ).pipe(
        Effect.map(() => "parsed"),
        Effect.catch((error) => Effect.succeed(error.message))
      )
    );
    expect(outcome).toContain("unrecognized argument");
    expect(outcome).toContain("--mesage-file");
    expect(outcome).not.toBe("parsed");
  });
});