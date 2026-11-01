import { describe, expect, test } from "bun:test";
// The host-rotated GH_TOKEN is the default App's installation token for the
// GITHUB_REPO org's installation only — an installation token never reaches
// another account. A --repo/--org target in a DIFFERENT org with no
// registered alternate App must therefore still reach that org the way the
// prompt documents (GH_APP_ALLOWED_ORGS + the default App's installation
// there), never silently hand back the own-org token every call then 404s
// on. A throwaway RSA key is generated at test time (never a real one).
import { generateKeyPairSync } from "node:crypto";

import { Effect } from "effect";

import { resolveGitHubToken } from "./gh-app-token-mint.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TEST_PEM_B64 = Buffer.from(
  privateKey.export({ format: "pem", type: "pkcs1" })
).toString("base64");

const ENV = {
  GH_APP_ALLOWED_ORGS: "owner,acme",
  GH_APP_ID: "12345",
  GH_APP_PRIVATE_KEY: TEST_PEM_B64,
  GH_TOKEN: "ghs_rotated",
  GITHUB_REPO: "owner/repo",
} as const;

/** A fetch that records every URL; the default App is installed on `owner` and `acme`. */
const recordingFetch = (urls: string[]) => (url: string) => {
  urls.push(url);
  return Promise.resolve(
    url.includes("/app/installations?")
      ? Response.json([
          { account: { login: "owner" }, id: 1111 },
          { account: { login: "acme" }, id: 4242 },
        ])
      : Response.json(
          { expires_at: "2026-01-01T00:00:00Z", token: "ghs_acme_minted" },
          { status: 201 }
        )
  );
};

const resolve = (
  urls: string[],
  targetRepo: string,
  env: Readonly<Record<string, string | undefined>> = ENV
) =>
  resolveGitHubToken({
    cache: null,
    clock: () => 1_700_000_000_000,
    env,
    fetchImpl: recordingFetch(urls),
    registry: () => null,
    targetRepo,
  });

describe("resolveGitHubToken — a target outside the GITHUB_REPO org", () => {
  test("an allowlisted foreign org with no registered App reaches that org's installation, not the own-org rotated token", async () => {
    const urls: string[] = [];
    const token = await Effect.runPromise(resolve(urls, "acme/widgets"));
    expect(token.token).toBe("ghs_acme_minted");
    expect(urls.at(-1)).toBe(
      "https://api.github.com/app/installations/4242/access_tokens"
    );
  });

  test("a foreign org outside the allowlist fails closed instead of exiting 0 with a token that cannot see it", async () => {
    const urls: string[] = [];
    const error = await Effect.runPromise(
      Effect.flip(resolve(urls, "stranger/widgets"))
    );
    expect(error.message).toContain("stranger");
    expect(urls.some((url) => url.includes("/access_tokens"))).toBe(false);
  });

  test("the own org stays on the rotated GH_TOKEN with no network call, case-blind", async () => {
    for (const target of ["owner/repo", "Owner/other", "https://github.com/OWNER/x"]) {
      const urls: string[] = [];
      const token = await Effect.runPromise(resolve(urls, target));
      expect(token).toEqual({ token: "ghs_rotated" });
      expect(urls).toEqual([]);
    }
  });

  test("an unset GITHUB_REPO keeps the rotated GH_TOKEN (no own org to compare against)", async () => {
    const urls: string[] = [];
    const token = await Effect.runPromise(
      resolve(urls, "acme/widgets", { ...ENV, GITHUB_REPO: undefined })
    );
    expect(token).toEqual({ token: "ghs_rotated" });
    expect(urls).toEqual([]);
  });
});
