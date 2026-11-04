import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { displayArgvToken } from "@ori-monorepo/working-with-github/gh-app-registry.ts";

// Regression: displayArgvToken (#371) withheld an argv token only when it
// spanned lines or ran past 64 characters. GitHub's own tokens are 40
// characters (`ghs_` + 36 for an installation token, likewise ghp_/gho_/
// ghu_/ghr_), so every CLI still quoted one whole when it was pasted as a
// positional or in the equals form:
//   mint-token.ts --repo acme/widgets "$TOKEN"
//   -> mint-token: unrecognized argument "ghs_…" — …
// A token carrying a GitHub credential shape is now named by its length.

const GHS = "ghs_16C7e42F292c6912E7710c838347Ae178B4a";
const GHP = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

const SCRIPTS = import.meta.dir;

const run = (script: string, argv: readonly string[]) => {
  const registryDir = mkdtempSync(join(tmpdir(), "wwg-ghtoken-echo-"));
  try {
    const proc = Bun.spawnSync(["bun", join(SCRIPTS, script), ...argv], {
      env: {
        ...process.env,
        GH_APP_ID: "",
        GH_APP_REGISTRY_DIR: registryDir,
        GITHUB_REPO: "acme/widgets",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    return {
      code: proc.exitCode,
      output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    };
  } finally {
    rmSync(registryDir, { force: true, recursive: true });
  }
};

describe("a 40-character GitHub token in argv is withheld", () => {
  test("displayArgvToken names every GitHub token shape by its length", () => {
    expect(GHS).toHaveLength(40);
    for (const token of [
      GHS,
      GHP,
      "gho_abcdefghijklmnopqrstuvwxyz0123456789",
      "ghu_abcdefghijklmnopqrstuvwxyz0123456789",
      "ghr_abcdefghijklmnopqrstuvwxyz0123456789",
      `--repo=${GHS}`,
    ]) {
      expect(displayArgvToken(token)).toBe(
        `<a ${token.length}-character argument, withheld>`
      );
    }
  });

  test("short typos and repo spellings are still quoted as typed", () => {
    for (const token of ["-repo", "--org=acme", "acme/widgets", "ghost", "gh_pages"]) {
      expect(displayArgvToken(token)).toBe(token);
    }
  });

  test("mint-token withholds a token pasted as a positional", () => {
    const result = run("mint-token.ts", ["--repo", "acme/widgets", GHS]);
    expect(result.code).toBe(1);
    expect(result.output).not.toContain(GHS);
    expect(result.output).toContain("<a 40-character argument, withheld>");
  });

  test("mint-token withholds a token in the equals form", () => {
    const result = run("mint-token.ts", [`--repo=${GHS}`]);
    expect(result.code).toBe(1);
    expect(result.output).not.toContain(GHS);
  });

  test("cleanup-worktrees withholds a token pasted as a positional", () => {
    const result = run("cleanup-worktrees.ts", ["--dry-run", GHS]);
    expect(result.code).toBe(1);
    expect(result.output).not.toContain(GHS);
    expect(result.output).toContain("<a 40-character argument, withheld>");
  });

  test("register-gh-app withholds a token pasted as a positional", () => {
    const result = run("register-gh-app.ts", ["register", GHP]);
    expect(result.code).toBe(1);
    expect(result.output).not.toContain(GHP);
    expect(result.output).toContain("<a 40-character argument, withheld>");
  });
});
