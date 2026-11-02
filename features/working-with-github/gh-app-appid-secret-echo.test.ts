import { describe, expect, test } from "bun:test";

import { generateKeyPairSync } from "node:crypto";

import { Effect } from "effect";

import type { GhAppError } from "./gh-app-github-api.ts";

import { mintInstallationToken } from "./gh-app-token-mint.ts";

// The non-integer App id guard in signAppJwt echoed the raw value back. When
// the two App env vars are swapped (GH_APP_ID holding the base64 private key,
// or `register-gh-app.ts register` given --app-id-key and --private-key-key in
// reverse) that echo printed the WHOLE private key into mint-token's stderr,
// the schedule logs, and any chat the agent relays the error to — while the
// guard's own comment promised "the App id NAME, never a secret".

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM_B64 = Buffer.from(
  privateKey.export({ format: "pem", type: "pkcs1" })
).toString("base64");

const mintError = async (
  env: Record<string, string>,
  registryKeys?: { appIdKey: string; privateKeyKey: string }
): Promise<GhAppError> => {
  let fetched = false;
  const error = await Effect.runPromise(
    Effect.flip(
      mintInstallationToken({
        cache: null,
        env,
        fetchImpl: () => {
          fetched = true;
          return Promise.resolve(new Response("{}", { status: 201 }));
        },
        ...(registryKeys === undefined
          ? {}
          : { registry: () => registryKeys, targetRepo: "acme-corp/widgets" }),
      })
    )
  );
  expect(fetched).toBe(false);
  return error;
};

describe("the App id guard never echoes a secret-sized value", () => {
  test("GH_APP_ID and GH_APP_PRIVATE_KEY swapped: the private key is withheld", async () => {
    const error = await mintError({
      GH_APP_ID: PEM_B64,
      GH_APP_PRIVATE_KEY: "123456",
      GITHUB_REPO: "acme-corp/widgets",
    });
    expect(error.op).toBe("config");
    expect(error.message).toContain("positive integer");
    expect(error.message).not.toContain(PEM_B64);
    expect(error.message).not.toContain(PEM_B64.slice(0, 24));
    expect(error.message).toContain(`${PEM_B64.length}-character value`);
  });

  test("a registered App with its key names reversed: the private key is withheld", async () => {
    const error = await mintError(
      {
        GH_APP_ALLOWED_ORGS: "acme-corp",
        GITHUB_REPO: "acme-corp/widgets",
        TEAM_GH_APP_ID: "222",
        TEAM_GH_APP_PRIVATE_KEY: PEM_B64,
      },
      { appIdKey: "TEAM_GH_APP_PRIVATE_KEY", privateKeyKey: "TEAM_GH_APP_ID" }
    );
    expect(error.op).toBe("config");
    expect(error.message).not.toContain(PEM_B64.slice(0, 24));
  });

  test("a short mistyped id is still echoed, so the typo stays diagnosable", async () => {
    const error = await mintError({
      GH_APP_ID: "12o45",
      GH_APP_PRIVATE_KEY: PEM_B64,
      GITHUB_REPO: "acme-corp/widgets",
    });
    expect(error.message).toContain('"12o45"');
  });
});
