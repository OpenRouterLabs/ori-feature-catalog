import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import {
  parseCliArgs,
} from "./commit-via-api.ts";
import {
  parseCleanupArgs,
} from "./cleanup-worktrees.ts";
import { parseMintArgs, resolveMintDeps } from "./mint-token.ts";
import type { RegisterCliContext } from "./register-gh-app.ts";
import { runRegisterCli } from "./register-gh-app.ts";
import { listApps, openGhAppRegistryDb } from "../gh-app-registry.ts";

/**
 * A value that is a flag *modulo surrounding whitespace* (`--repo " --dry-run "`)
 * bypasses every CLI's flag-shaped-value guard, because all four parsers check
 * the raw token for `--` BEFORE trimming. The trimmed value is still unusable
 * garbage, but it now looks "clean" to the guard and flows on as a real value:
 *
 * - mint-token: `--repo " --purpose "` mints against `targetRepo="--purpose"`.
 * - cleanup-worktrees: `--repo " --dry-run "` sweeps `repo="--dry-run"` (and
 *   the real `--dry-run` is consumed as its value).
 * - register-gh-app: `--org " --purpose "` persists `org:"--purpose"` — a
 *   registry key no mint can ever produce (orgOf of a repo string never
 *   yields a `--`-prefixed login), the #101/#140 silent-dead-row class.
 * - commit-via-api: `--branch " --worktree "` parses clean, mints, creates
 *   blobs, then dies on the 404 from GET /git/ref/heads/--worktree — the
 *   late-failure class #94/#111 closed for the unpadded shape.
 *
 * All four must reject (or re-trim before deciding) the flag-shaped value.
 */
describe("a flag-shaped flag value padded with whitespace is rejected, not trimmed into a value", () => {
  // ─── mint-token.ts ────────────────────────────────────────────────────────

  test("mint-token: --repo with a padded flag-shaped value is a usage error", () => {
    // Pre-fix: {"targetRepo":"--purpose"} — the raw token failed the
    // startsWith("--") check, then trimmed to "--purpose".
    expect(parseMintArgs(["--repo", " --purpose "])).toEqual({
      missingRepoValue: true,
    });
  });

  test("mint-token: --purpose with a padded flag-shaped value is a usage error", () => {
    expect(parseMintArgs(["--purpose", " --repo ", "x"])).toEqual({
      missingPurposeValue: true,
    });
  });

  test("mint-token: the guards for the unpadded shapes are unchanged", () => {
    expect(parseMintArgs(["--repo", "--purpose", "reviewer"])).toEqual({
      missingRepoValue: true,
      purpose: "reviewer",
    });
    expect(parseMintArgs(["--purpose", "--repo", "acme/x"])).toEqual({
      missingPurposeValue: true,
    });
    expect(parseMintArgs(["--org", "acme-corp"])).toEqual({
      targetRepo: "acme-corp",
    });
  });

  // ─── cleanup-worktrees.ts ─────────────────────────────────────────────────

  test("cleanup-worktrees: --repo with a padded flag-shaped value is a usage error", () => {
    // Pre-fix: the flag-shaped token passed the guard after trimming, so the
    // sweep targeted repo="--dry-run" and never dried.
    const parsed = parseCleanupArgs(["--repo", " --dry-run "], {}, "/cwd");
    expect(parsed.missingFlagValue).toBe("--repo");
  });

  test("cleanup-worktrees: unpadded guards and normal values unchanged", () => {
    expect(
      parseCleanupArgs(["--repo", "--dry-run"], { GITHUB_REPO: "" }, "/cwd")
        .missingFlagValue
    ).toBe("--repo");
    expect(
      parseCleanupArgs(
        ["--repo", "o/r", "--worktrees-root", " /tmp/w "],
        {},
        "/cwd"
      )
    ).toEqual({
      dryRun: false,
      repo: "o/r",
      repoDir: "/cwd",
      worktreesRoot: "/tmp/w",
    });
  });

  // ─── commit-via-api.ts ────────────────────────────────────────────────────

  test("commit-via-api: a padded flag-shaped --branch value fails the parse", async () => {
    // Pre-fix: parsed clean with branch="--worktree" (after trim), minted,
    // created blobs, then died on the 404 from
    // GET /git/ref/heads/--worktree — after side effects.
    const outcome = await Effect.runPromise(
      parseCliArgs([
        "--worktree",
        "/w",
        "--branch",
        " --worktree ",
        "--message-file",
        "/m",
      ]).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (value) => ({ ok: true as const, value }),
        })
      )
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.stage).toBe("args");
      expect(outcome.error.message).toContain("--branch");
    }
  });

  test("commit-via-api: unpadded flag-shaped values and normal values unchanged", async () => {
    // The #94/#111 guards keep firing for the raw token, and a padded REAL
    // value still trims to its usable self.
    const unpadded = await Effect.runPromise(
      parseCliArgs([
        "--worktree",
        "/w",
        "--branch",
        "--worktree",
        "--message-file",
        "/m",
      ]).pipe(
        Effect.match({
          onFailure: (error) => `ERR: ${error.message}`,
          onSuccess: () => "OK",
        })
      )
    );
    expect(unpadded).toContain("missing its value");
    const trimmedReal = await Effect.runPromise(
      parseCliArgs([
        "--worktree",
        "/w",
        "--branch",
        " fix-x ",
        "--message-file",
        "/m",
      ], { GITHUB_REPO: "owner/repo" })
    );
    expect(trimmedReal.branch).toBe("fix-x");
  });

  // ─── register-gh-app.ts ───────────────────────────────────────────────────

  test("register-gh-app: a padded flag-shaped --org is refused, never persisted", () => {
    // Pre-fix: exit 0, `registered --purpose (default) → …`, and a row
    // org:"--purpose" persisted — a key no mint can ever look up (orgOf of
    // any repo string never yields a --prefixed login), the silent-dead-row
    // class #101/#140 closed for the unpadded shapes.
    const out: string[] = [];
    const err: string[] = [];
    const db = openGhAppRegistryDb(":memory:");
    const code = runRegisterCli({
      argv: [
        "register",
        "--org",
        " --purpose ",
        "--app-id-key",
        "TEAM_GH_APP_ID",
        "--private-key-key",
        "TEAM_GH_APP_PRIVATE_KEY",
      ],
      db,
      env: {
        TEAM_GH_APP_ID: "1",
        TEAM_GH_APP_PRIVATE_KEY: "x",
      },
      writers: {
        err: (text) => {
          err.push(text);
        },
        out: (text) => {
          out.push(text);
        },
      },
    } satisfies RegisterCliContext);
    expect(code).toBe(1);
    expect(listApps(db)).toHaveLength(0);
    expect(err.join("")).toContain("--org");
    expect(out).toEqual([]);
    db.close();
  });

  test("register-gh-app: the unpadded flag-shaped guards are unchanged", () => {
    const out: string[] = [];
    const err: string[] = [];
    const db = openGhAppRegistryDb(":memory:");
    // `--org --app-id-key X` (raw token) — the pre-existing guard.
    const code = runRegisterCli({
      argv: [
        "register",
        "--org",
        "--app-id-key",
        "TEAM_GH_APP_ID",
        "--private-key-key",
        "TEAM_GH_APP_PRIVATE_KEY",
      ],
      db,
      env: { TEAM_GH_APP_ID: "1", TEAM_GH_APP_PRIVATE_KEY: "x" },
      writers: {
        err: (text) => {
          err.push(text);
        },
        out: (text) => {
          out.push(text);
        },
      },
    } satisfies RegisterCliContext);
    expect(code).toBe(1);
    expect(listApps(db)).toHaveLength(0);
    db.close();
  });

  test("register-gh-app: a PADDED flag-shaped --purpose slot is refused, not coerced to the catch-all", () => {
    // The purpose-slot guard tests the RAW token, bypassing readFlag: a slot
    // that is a flag modulo whitespace (" --app-id-key ") passed it, then
    // readFlag trimmed the flag away and the purpose silently coerced to
    // "default" — persisting the org-level CATCH-ALL row with exit 0 (#117
    // reopened through padding). The register --org dead-row test above
    // covers the other flag; this one pins the slot guard itself.
    const out: string[] = [];
    const err: string[] = [];
    const db = openGhAppRegistryDb(":memory:");
    const code = runRegisterCli({
      argv: [
        "register",
        "--org",
        "acme",
        "--purpose",
        " --app-id-key ",
        "--app-id-key",
        "TEAM_GH_APP_ID",
        "--private-key-key",
        "TEAM_GH_APP_PRIVATE_KEY",
      ],
      db,
      env: { TEAM_GH_APP_ID: "1", TEAM_GH_APP_PRIVATE_KEY: "x" },
      writers: {
        err: (text) => {
          err.push(text);
        },
        out: (text) => {
          out.push(text);
        },
      },
    } satisfies RegisterCliContext);
    expect(code).toBe(1);
    // Especially: no catch-all row was persisted.
    expect(listApps(db)).toHaveLength(0);
    expect(err.join("")).toContain("--purpose");
    expect(out).toEqual([]);
    db.close();
  });
});
