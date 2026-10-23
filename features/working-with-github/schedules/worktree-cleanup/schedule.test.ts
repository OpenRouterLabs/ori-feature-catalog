import { describe, expect, test } from "bun:test";
// This suite value-imports `repo-dir.ts` (never `schedule.ts`, whose only
// other import is `ori`): `bun test` runs it on a fresh checkout where `ori`
// is a gitignored local SDK, so a value-import of the schedule module fails
// with `Cannot find package 'ori'` and the whole file errors out — the same
// fresh-checkout failure class PR#149 closed for gh-auth-health's resolver
// suite. The resolver itself is the `ori`-free module the schedule imports,
// so the contract it pins still guards the schedule's sweep path.
import { resolveRepoDir } from "./repo-dir.ts";

describe("resolveRepoDir", () => {
  test("prefers ORI_INTERN_WORKSPACE_ROOT over process.cwd()", () => {
    const previous = process.env.ORI_INTERN_WORKSPACE_ROOT;
    const previousPwd = process.cwd;
    try {
      // The standard intern layout: the daemon runs from /workspace, one
      // level ABOVE the actual git checkout.
      process.env.ORI_INTERN_WORKSPACE_ROOT = "/workspace/intern";
      process.cwd = () => "/workspace";
      expect(resolveRepoDir()).toBe("/workspace/intern");
    } finally {
      process.cwd = previousPwd;
      if (previous === undefined) {
        delete process.env.ORI_INTERN_WORKSPACE_ROOT;
      } else {
        process.env.ORI_INTERN_WORKSPACE_ROOT = previous;
      }
    }
  });

  test("falls back to process.cwd() when ORI_INTERN_WORKSPACE_ROOT is unset", () => {
    const previous = process.env.ORI_INTERN_WORKSPACE_ROOT;
    const previousPwd = process.cwd;
    try {
      delete process.env.ORI_INTERN_WORKSPACE_ROOT;
      process.cwd = () => "/somewhere/else";
      expect(resolveRepoDir()).toBe("/somewhere/else");
    } finally {
      process.cwd = previousPwd;
      if (previous !== undefined) {
        process.env.ORI_INTERN_WORKSPACE_ROOT = previous;
      }
    }
  });

  test("treats a blank ORI_INTERN_WORKSPACE_ROOT as unset (falls back to cwd)", () => {
    const previous = process.env.ORI_INTERN_WORKSPACE_ROOT;
    const previousPwd = process.cwd;
    try {
      process.env.ORI_INTERN_WORKSPACE_ROOT = "   ";
      process.cwd = () => "/fallback";
      expect(resolveRepoDir()).toBe("/fallback");
    } finally {
      process.cwd = previousPwd;
      if (previous === undefined) {
        delete process.env.ORI_INTERN_WORKSPACE_ROOT;
      } else {
        process.env.ORI_INTERN_WORKSPACE_ROOT = previous;
      }
    }
  });

  test("trims surrounding whitespace from ORI_INTERN_WORKSPACE_ROOT, matching its own blank check", () => {
    // A padded value otherwise goes through raw, every git command runs from
    // a nonexistent directory, and the daily sweep silently no-ops.
    const previous = process.env.ORI_INTERN_WORKSPACE_ROOT;
    try {
      process.env.ORI_INTERN_WORKSPACE_ROOT = " /real/path ";
      expect(resolveRepoDir()).toBe("/real/path");
    } finally {
      if (previous === undefined) {
        delete process.env.ORI_INTERN_WORKSPACE_ROOT;
      } else {
        process.env.ORI_INTERN_WORKSPACE_ROOT = previous;
      }
    }
  });
});