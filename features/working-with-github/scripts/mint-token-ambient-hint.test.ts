import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

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
