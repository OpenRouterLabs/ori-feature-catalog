import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CommitApiError } from "./commit-api-core.ts";
import { withAmbientHint } from "./commit-via-api.ts";

// Regression: in ambient mode (GH_APP_ID unset) a commit-via-api run without
// `--as member` died on the App-mode diagnostic
//   commit-via-api: [mint] GH_TOKEN is not set — the default App's token is
//   rotated by the host and injected as GH_TOKEN; it is never minted here
// which names no remedy that works there. `--as member` is the one way to
// commit in ambient mode, so the diagnostic now names it.

const HINT = "pass --as member to commit as the person asking";

describe("withAmbientHint", () => {
  const mint = new CommitApiError({ stage: "mint", message: "GH_TOKEN is not set" });

  test("a mint failure with no GH_APP_ID names --as member", () => {
    expect(withAmbientHint(mint, {})).toContain(HINT);
    expect(withAmbientHint(mint, { GH_APP_ID: "  " })).toContain(HINT);
    expect(withAmbientHint(mint, {})).toStartWith("GH_TOKEN is not set");
  });

  test("App mode and other stages keep their message as-is", () => {
    expect(withAmbientHint(mint, { GH_APP_ID: "123" })).toBe("GH_TOKEN is not set");
    const args = new CommitApiError({ stage: "args", message: "bad flag" });
    expect(withAmbientHint(args, {})).toBe("bad flag");
  });
});

describe("commit-via-api CLI in ambient mode without --as member", () => {
  test("the failure names --as member", () => {
    const dir = mkdtempSync(join(tmpdir(), "wwg-ambient-hint-"));
    try {
      const msg = join(dir, "msg.txt");
      writeFileSync(msg, "fix: x\n");
      const proc = Bun.spawnSync(
        [
          "bun",
          join(import.meta.dir, "commit-via-api.ts"),
          "--worktree",
          dir,
          "--branch",
          "fix-x",
          "--message-file",
          msg,
          "--repo",
          "acme/widgets",
        ],
        {
          env: {
            ...process.env,
            GH_APP_ID: "",
            GH_TOKEN: "",
            GH_APP_REGISTRY_DIR: dir,
            GITHUB_REPO: "acme/widgets",
          },
          stderr: "pipe",
          stdout: "pipe",
        }
      );
      const stderr = proc.stderr.toString();
      expect(proc.exitCode).toBe(1);
      expect(stderr).toContain("commit-via-api: [mint]");
      expect(stderr).toContain(HINT);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

// Regression: a registered alternate App's mint failure in ambient mode
// printed "no token can be resolved here: pass --as member", but that token
// resolves once its env var is fixed, and --as member would commit as the
// person instead of the App the operator registered for the repo's org.
describe("a registered App's mint failure keeps its own message", () => {
  test("withAmbientHint leaves a registered mint failure as-is", () => {
    const registered = new CommitApiError({
      stage: "mint",
      message: "Missing GitHub App env var(s): A_KEY",
      registered: true,
    });
    expect(withAmbientHint(registered, {})).toBe(registered.message);
  });

  test("the CLI names the registered App's missing var, not --as member", () => {
    const dir = mkdtempSync(join(tmpdir(), "wwg-registered-commit-hint-"));
    try {
      const msg = join(dir, "msg.txt");
      writeFileSync(msg, "fix: x\n");
      const env = {
        ...process.env,
        A_ID: "123",
        A_KEY: "x",
        GH_APP_ID: "",
        GH_APP_REGISTRY_DIR: dir,
        GH_TOKEN: "",
        GITHUB_REPO: "acme/widgets",
      };
      const register = Bun.spawnSync(
        ["bun", join(import.meta.dir, "register-gh-app.ts"), "register", "--org", "acme", "--app-id-key", "A_ID", "--private-key-key", "A_KEY"],
        { env, stderr: "pipe", stdout: "pipe" }
      );
      expect(register.exitCode).toBe(0);
      const proc = Bun.spawnSync(
        ["bun", join(import.meta.dir, "commit-via-api.ts"), "--worktree", dir, "--branch", "fix-x", "--message-file", msg, "--repo", "acme/widgets"],
        { env: { ...env, A_KEY: "" }, stderr: "pipe", stdout: "pipe" }
      );
      const stderr = proc.stderr.toString();
      expect(proc.exitCode).toBe(1);
      expect(stderr).toContain("commit-via-api: [mint] Missing GitHub App env var(s): A_KEY");
      expect(stderr).not.toContain(HINT);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
