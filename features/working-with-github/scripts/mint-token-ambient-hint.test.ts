import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { resolveGitHubToken } from "@ori-monorepo/working-with-github/gh-app-token-mint.ts";
import { GhAppError } from "@ori-monorepo/working-with-github/gh-app-token.ts";

import { runMint, withAmbientMintHint } from "./mint-token.ts";

// Regression: in ambient mode (no GH_APP_ID) the change flow's first line,
// TOKEN=$(bun "$WWG"/scripts/mint-token.ts), died on
//   mint-token: GH_TOKEN is not set — the default App's token is rotated by
//   the host and injected as GH_TOKEN; it is never minted here
// which the prompt reads as broken host rotation, never naming the ambient
// path (plain curl, commit-via-api.ts --as member) that works there.

const unset = new GhAppError({
  op: "config",
  message:
    "GH_TOKEN is not set — the default App's token is rotated by the host and injected as GH_TOKEN; it is never minted here",
});

const run = async (error: GhAppError, env: Record<string, string | undefined>) => {
  const err: string[] = [];
  const code = await Effect.runPromise(
    runMint(Effect.fail(error), { err: (t) => void err.push(t), out: () => undefined }, env)
  );
  return { code, err: err.join("") };
};

describe("mint-token names the ambient path when no GH_APP_ID is set", () => {
  test("a config failure in ambient mode says nothing is broken and names curl and --as member", async () => {
    const { code, err } = await run(unset, {});
    expect(code).toBe(1);
    expect(err).toStartWith("mint-token: GH_TOKEN is not set");
    expect(err).toContain("no GH_APP_ID is set (ambient mode)");
    expect(err).toContain("plain curl");
    expect(err).toContain("commit-via-api.ts --as member");
  });

  test("the missing-App-vars failure of a cross-org target gets the hint too", () => {
    const missing = new GhAppError({ op: "config", message: "Missing GitHub App env var(s): GH_APP_ID, GH_APP_PRIVATE_KEY" });
    expect(withAmbientMintHint(missing, { GH_APP_ID: "  " })).toContain("ambient mode");
  });

  test("App mode keeps the plain message", async () => {
    const { err } = await run(unset, { GH_APP_ID: "123" });
    expect(err).toBe(`mint-token: ${unset.message}\n`);
  });

  test("an HTTP failure is never relabelled ambient", () => {
    const http = new GhAppError({ op: "http", status: 401, message: "Bad credentials" });
    expect(withAmbientMintHint(http, {})).toBe("Bad credentials");
  });
});

// Regression: a registered alternate App mints with no GH_APP_ID at all, so
// its failure is about THAT App. Pre-fix an ambient workspace with a
// registered row whose key var was empty printed
//   mint-token: Missing GitHub App env var(s): A_KEY — no GH_APP_ID is set
//   (ambient mode), so there is no App to mint from and nothing is broken
// sending the caller away from the one env var that needed fixing.
describe("a registered App's failure never gets the ambient hint", () => {
  test("a registered config failure keeps its message as-is", () => {
    const registered = new GhAppError({
      op: "config",
      message: "Missing GitHub App env var(s): A_KEY",
      registered: true,
    });
    expect(withAmbientMintHint(registered, {})).toBe(registered.message);
  });

  test("resolveGitHubToken marks a registered App's failure, not the default path's", async () => {
    const env = { A_ID: "123", A_KEY: "", GITHUB_REPO: "acme/widgets" };
    const keys = { appIdKey: "A_ID", privateKeyKey: "A_KEY" };
    const registeredError = await Effect.runPromise(
      Effect.flip(
        resolveGitHubToken({ cache: null, env, registry: () => keys, targetRepo: "acme/widgets" })
      )
    );
    expect(registeredError.registered).toBe(true);
    expect(registeredError.message).toContain("A_KEY");
    const defaultError = await Effect.runPromise(
      Effect.flip(
        resolveGitHubToken({ cache: null, env, registry: () => null, targetRepo: "acme/widgets" })
      )
    );
    expect(defaultError.registered).toBeUndefined();
    expect(withAmbientMintHint(defaultError, env)).toContain("ambient mode");
  });

  test("the CLI names the registered App's missing var with no ambient claim", () => {
    const dir = mkdtempSync(join(tmpdir(), "wwg-registered-hint-"));
    try {
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
      const mint = Bun.spawnSync(
        ["bun", join(import.meta.dir, "mint-token.ts"), "--org", "acme"],
        { env: { ...env, A_KEY: "" }, stderr: "pipe", stdout: "pipe" }
      );
      const stderr = mint.stderr.toString();
      expect(mint.exitCode).toBe(1);
      expect(mint.stdout.toString()).toBe("");
      expect(stderr).toContain("mint-token: Missing GitHub App env var(s): A_KEY");
      expect(stderr).not.toContain("ambient mode");
      expect(stderr).not.toContain("nothing is broken");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
