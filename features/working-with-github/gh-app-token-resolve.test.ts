import { describe, expect, test } from "bun:test";
// The default App's token is rotated by the host and read from GH_TOKEN; only a
// registered alternate App still mints. A throwaway RSA key is generated at
// test time (never a real one) for the alternate-App mint path.
import { generateKeyPairSync } from "node:crypto";

import { Effect } from "effect";

import { resolveGitHubToken } from "./gh-app-token-mint.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TEST_PEM_B64 = Buffer.from(
  privateKey.export({ format: "pem", type: "pkcs1" })
).toString("base64");

const ALT_KEYS = { appIdKey: "ALT_APP_ID", privateKeyKey: "ALT_APP_KEY" };

const ENV = {
  ALT_APP_ID: "777",
  ALT_APP_KEY: TEST_PEM_B64,
  GH_APP_ID: "12345",
  GH_APP_PRIVATE_KEY: TEST_PEM_B64,
  GH_TOKEN: "ghs_rotated",
  GITHUB_REPO: "owner/repo",
} as const;

/** A fetch that records every URL and answers discovery + the token POST for `acme`. */
const recordingFetch = (urls: string[]) => (url: string) => {
  urls.push(url);
  return Promise.resolve(
    url.includes("/app/installations?")
      ? Response.json([{ account: { login: "acme" }, id: 4242 }])
      : Response.json(
          { expires_at: "2026-01-01T00:00:00Z", token: "ghs_alt_minted" },
          { status: 201 }
        )
  );
};

describe("resolveGitHubToken", () => {
  test("the bare default returns the rotated GH_TOKEN without any network call", async () => {
    const urls: string[] = [];
    const token = await Effect.runPromise(
      resolveGitHubToken({ cache: null, env: ENV, fetchImpl: recordingFetch(urls) })
    );
    expect(token).toEqual({ token: "ghs_rotated" });
    expect(urls).toEqual([]);
  });

  test("a target with no registered App returns the rotated GH_TOKEN without minting", async () => {
    const urls: string[] = [];
    const token = await Effect.runPromise(
      resolveGitHubToken({
        cache: null,
        env: ENV,
        fetchImpl: recordingFetch(urls),
        registry: () => null,
        targetRepo: "owner/repo",
      })
    );
    expect(token).toEqual({ token: "ghs_rotated" });
    expect(urls).toEqual([]);
  });

  test("an unset GH_TOKEN fails as a config error instead of minting", async () => {
    const urls: string[] = [];
    const error = await Effect.runPromise(
      Effect.flip(
        resolveGitHubToken({
          cache: null,
          env: { ...ENV, GH_TOKEN: "  " },
          fetchImpl: recordingFetch(urls),
        })
      )
    );
    expect(error.op).toBe("config");
    expect(error.message).toContain("GH_TOKEN");
    expect(urls).toEqual([]);
  });

  test("a target routed to a registered alternate App mints that App's token", async () => {
    const urls: string[] = [];
    const token = await Effect.runPromise(
      resolveGitHubToken({
        allowedOrgs: ["acme"],
        cache: null,
        clock: () => 1_700_000_000_000,
        env: ENV,
        fetchImpl: recordingFetch(urls),
        purpose: "reviewer",
        registry: () => ALT_KEYS,
        targetRepo: "acme/widgets",
      })
    );
    expect(token).toEqual({
      expiresAt: "2026-01-01T00:00:00Z",
      token: "ghs_alt_minted",
    });
    expect(urls.at(-1)).toBe(
      "https://api.github.com/app/installations/4242/access_tokens"
    );
  });
});
