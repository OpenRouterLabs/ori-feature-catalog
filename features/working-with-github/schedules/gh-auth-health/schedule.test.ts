import { describe, expect, test } from "bun:test";
// A throwaway RSA key is generated at test time (never a real one) so the JWT
// signing path is exercised for real without embedding any secret.
import { generateKeyPairSync } from "node:crypto";

import { Effect } from "effect";

import type { InstallationToken } from "@ori-monorepo/working-with-github/gh-app-token.ts";

import { mintInstallationToken } from "@ori-monorepo/working-with-github/gh-app-token-mint.ts";
import {
  GhAppError,
  readGhAppCredentials,
} from "@ori-monorepo/working-with-github/gh-app-token.ts";

import type { HealthCheckOk } from "./gh-auth-health.ts";

import { readGhAuthHealthConfig } from "./config.ts";
import {
  HealthCheckError,
  ambientGitHubReachable,
  formatHealthErrorLog,
  formatHealthOkLog,
  ghAuthHealthCheck,
  renderHealthAlert,
} from "./gh-auth-health.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TEST_PEM_B64 = Buffer.from(
  privateKey.export({
    format: "pem",
    type: "pkcs1",
  })
).toString("base64");

const FULL_ENV = {
  GH_APP_ID: "12345",
  GH_APP_PRIVATE_KEY: TEST_PEM_B64,
  GITHUB_REPO: "owner/repo",
} as const;

const TEST_REPO = "owner/repo";

const jsonResponse = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * A fetch that satisfies installation discovery (`GET /app/installations` →
 * a single `owner` installation, id 67890) and delegates the token POST to
 * `onToken`. The default App has no pinned installation id, so every mint first
 * discovers; these mint tests only care about the token POST behaviour.
 */
const discoveryThen =
  (onToken: (url: string, init?: RequestInit) => Response): FetchLike =>
  (url, init) => {
    if (url.includes("/app/installations?")) {
      return Promise.resolve(
        jsonResponse([
          {
            account: { login: "owner" },
            id: 67_890,
          },
        ])
      );
    }
    return Promise.resolve(onToken(url, init));
  };

/** True if `value` looks like a Headers-shaped record (an object, not an array). */
const isHeaderRecord = (value: unknown): value is Record<string, string> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Read a request header from an injected fetch's init, without unsafe casts. */
const authHeader = (init?: RequestInit): string => {
  const headers = init?.headers;
  if (isHeaderRecord(headers)) {
    return headers.Authorization ?? "";
  }
  return "";
};

type Outcome<A, E> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: E };

/**
 * Test-local helper: run an Effect and fold BOTH channels into a plain tagged
 * object so assertions can branch on success vs failure. This is assertion
 * scaffolding only — the production code carries no `Result`/`ok` shape; the
 * healthy/failed split lives in the Effect success/failure channels.
 */
const runToOutcome = <A, E>(
  effect: Effect.Effect<A, E>
): Promise<Outcome<A, E>> =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({
        onSuccess: (value) => ({
          ok: true as const,
          value,
        }),
        onFailure: (error) => ({
          ok: false as const,
          error,
        }),
      })
    )
  );

// ─── readGhAppCredentials ───────────────────────────────────────────────────

describe("readGhAppCredentials", () => {
  test("succeeds with credentials when all keys are present", async () => {
    const outcome = await runToOutcome(readGhAppCredentials({ env: FULL_ENV }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.appId).toBe("12345");
      // Org derived from GITHUB_REPO for installation discovery; no pinned id.
      expect(outcome.value.org).toBe("owner");
    }
  });

  test("fails reporting missing key NAMES only (never values)", async () => {
    const outcome = await runToOutcome(
      readGhAppCredentials({ env: { GH_APP_ID: "12345" } })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.message).toContain("GH_APP_PRIVATE_KEY");
      expect(outcome.error.message).not.toContain("12345");
    }
  });

  test("treats an empty-string value as missing", async () => {
    const outcome = await runToOutcome(
      readGhAppCredentials({
        env: {
          ...FULL_ENV,
          GH_APP_PRIVATE_KEY: "",
        },
      })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.message).toContain("GH_APP_PRIVATE_KEY");
    }
  });
});

// ─── mintInstallationToken ────────────────────────────────────────────────────

describe("mintInstallationToken", () => {
  test("signs a JWT and succeeds with the token from a 201 response", async () => {
    let capturedAuth = "";
    let tokenUrl = "";
    const outcome = await runToOutcome(
      mintInstallationToken({
        allowedOrgs: ["owner"],
        cache: null,
        clock: () => 1_700_000_000_000,
        env: FULL_ENV,
        fetchImpl: discoveryThen((url, init) => {
          tokenUrl = url;
          capturedAuth = authHeader(init);
          return jsonResponse(
            {
              expires_at: "2026-01-01T00:00:00Z",
              token: "ghs_minted",
            },
            201
          );
        }),
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.token).toBe("ghs_minted");
      expect(outcome.value.expiresAt).toBe("2026-01-01T00:00:00Z");
    }
    // Minted against the discovered installation (owner → 67890).
    expect(tokenUrl).toBe(
      "https://api.github.com/app/installations/67890/access_tokens"
    );
    // A real RS256 JWT (header.payload.signature) was produced and sent.
    expect(capturedAuth.startsWith("Bearer ")).toBe(true);
    expect(capturedAuth.split(".").length).toBe(3);
  });

  test("fails with a config GhAppError when credentials are absent", async () => {
    const outcome = await runToOutcome(
      mintInstallationToken({
        cache: null,
        env: {},
        fetchImpl: () => Promise.resolve(jsonResponse({})),
      })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(GhAppError);
      expect(outcome.error.message).toContain("Missing GitHub App env var");
    }
  });

  test("surfaces GitHub's error message on a non-2xx response", async () => {
    const outcome = await runToOutcome(
      mintInstallationToken({
        allowedOrgs: ["owner"],
        cache: null,
        env: FULL_ENV,
        fetchImpl: discoveryThen(() =>
          jsonResponse({ message: "Bad credentials" }, 401)
        ),
      })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.message).toContain("Bad credentials");
    }
  });

  test("fails when the response omits a token", async () => {
    const outcome = await runToOutcome(
      mintInstallationToken({
        allowedOrgs: ["owner"],
        cache: null,
        env: FULL_ENV,
        fetchImpl: discoveryThen(() => jsonResponse({ expires_at: "x" }, 201)),
      })
    );
    expect(outcome.ok).toBe(false);
  });

  test("captures a network error in the failure channel instead of throwing", async () => {
    const outcome = await runToOutcome(
      mintInstallationToken({
        allowedOrgs: ["owner"],
        cache: null,
        env: FULL_ENV,
        fetchImpl: discoveryThen(() => {
          throw new Error("ECONNREFUSED");
        }),
      })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.message).toContain("ECONNREFUSED");
    }
  });
});

// ─── ghAuthHealthCheck ────────────────────────────────────────────────────────

const okToken: InstallationToken = {
  expiresAt: "2026-01-01T00:00:00Z",
  token: "ghs_live",
};
const okMint: Effect.Effect<InstallationToken, GhAppError> =
  Effect.succeed(okToken);

describe("ghAuthHealthCheck", () => {
  test("succeeds when mint succeeds and the repo round-trip resolves", async () => {
    let sentToken = "";
    const outcome = await runToOutcome(
      ghAuthHealthCheck({
        fetchImpl: (_url, init) => {
          sentToken = authHeader(init);
          return Promise.resolve(jsonResponse({ full_name: TEST_REPO }));
        },
        mint: okMint,
        repo: TEST_REPO,
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.repoFullName).toBe(TEST_REPO);
    }
    // The minted token is the one used for the round-trip.
    expect(sentToken).toBe("Bearer ghs_live");
  });

  test("fails at the mint stage when minting fails (no fetch attempted)", async () => {
    let fetchCalled = false;
    const outcome = await runToOutcome(
      ghAuthHealthCheck({
        fetchImpl: () => {
          fetchCalled = true;
          return Promise.resolve(jsonResponse({}));
        },
        mint: Effect.fail(
          new GhAppError({
            op: "config",
            message: "Missing GitHub App env var(s): GH_APP_ID",
          })
        ),
        repo: TEST_REPO,
      })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.stage).toBe("mint");
    }
    expect(fetchCalled).toBe(false);
  });

  test("fails at the round-trip stage on a 404 from the repo endpoint", async () => {
    const outcome = await runToOutcome(
      ghAuthHealthCheck({
        fetchImpl: () =>
          Promise.resolve(jsonResponse({ message: "Not Found" }, 404)),
        mint: okMint,
        repo: TEST_REPO,
      })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.stage).toBe("round-trip");
      expect(outcome.error.detail).toContain("Not Found");
    }
  });

  test("a malformed full_name fails the round-trip naming the field", async () => {
    const outcome = await runToOutcome(
      ghAuthHealthCheck({
        fetchImpl: () => Promise.resolve(jsonResponse({ full_name: 7 })),
        mint: okMint,
        repo: TEST_REPO,
      })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.stage).toBe("round-trip");
      expect(outcome.error.detail).toContain("full_name");
      expect(outcome.error.detail).toContain("Expected string");
    }
  });

  test("unknown extra fields on the repo body are tolerated", async () => {
    const outcome = await runToOutcome(
      ghAuthHealthCheck({
        fetchImpl: () =>
          Promise.resolve(
            jsonResponse({
              archived: false,
              default_branch: "main",
              full_name: TEST_REPO,
              id: 12345,
              some_field_added_next_year: true,
            })
          ),
        mint: okMint,
        repo: TEST_REPO,
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.repoFullName).toBe(TEST_REPO);
    }
  });

  test("round-trip network error is captured in the failure channel, not thrown", async () => {
    const outcome = await runToOutcome(
      ghAuthHealthCheck({
        fetchImpl: () => Promise.reject(new Error("socket hang up")),
        mint: okMint,
        repo: TEST_REPO,
      })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.stage).toBe("round-trip");
    }
  });
});

// ─── rendering + config ───────────────────────────────────────────────────────

describe("renderHealthAlert + formatHealthLog", () => {
  test("alert names the failing stage and detail", () => {
    const failure = new HealthCheckError({
      detail: "Bad credentials",
      stage: "mint",
    });
    const text = renderHealthAlert(TEST_REPO, failure);
    expect(text).toContain(":rotating_light:");
    expect(text).toContain("token mint");
    expect(text).toContain("Bad credentials");
  });

  test("success log line carries no token material", () => {
    const ok: HealthCheckOk = {
      repoFullName: TEST_REPO,
      tokenExpiresAt: "2026-01-01T00:00:00Z",
    };
    const line = formatHealthOkLog(TEST_REPO, ok);
    expect(line).toContain("ok");
    expect(line).not.toContain("ghs_");
  });

  test("failure log line names the stage", () => {
    const failure = new HealthCheckError({
      detail: "Not Found",
      stage: "round-trip",
    });
    const line = formatHealthErrorLog(TEST_REPO, failure);
    expect(line).toContain("FAILED at round-trip");
    expect(line).toContain("Not Found");
  });
});

describe("readGhAuthHealthConfig", () => {
  test("prefers the explicit alert channel override", () => {
    const config = readGhAuthHealthConfig({
      GH_AUTH_HEALTH_ALERT_CHANNEL_ID: "C123",
    });
    expect(config.alertChannelId).toBe("C123");
  });

  test("leaves the alert channel undefined when nothing is set", () => {
    const config = readGhAuthHealthConfig({});
    expect(config.alertChannelId).toBeUndefined();
  });

  test("treats an empty-string channel env as unset", () => {
    const config = readGhAuthHealthConfig({
      GH_AUTH_HEALTH_ALERT_CHANNEL_ID: "",
    });
    expect(config.alertChannelId).toBeUndefined();
  });
});

// ─── ambientGitHubReachable (the no-App probe) ────────────────────────────────

/** A `Response` with controllable status and `x-oauth-scopes` header. */
const githubRootResponse = (
  status: number,
  scopes?: string
): Response =>
  new Response(JSON.stringify({}), {
    headers: scopes === undefined ? {} : { "x-oauth-scopes": scopes },
    status,
  });

describe("ambientGitHubReachable", () => {
  test("succeeds and echoes the scopes when the proxy attaches a credential", async () => {
    let sentAuth = "";
    let calledUrl = "";
    const outcome = await runToOutcome(
      ambientGitHubReachable({
        fetchImpl: (url, init) => {
          calledUrl = url;
          const headers = init?.headers;
          if (typeof headers === "object" && headers !== null) {
            sentAuth = (headers as Record<string, string>).Authorization ?? "";
          }
          return Promise.resolve(
            githubRootResponse(200, "repo, read:org")
          );
        },
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.mode).toBe("ambient");
      expect(outcome.value.scopes).toBe("repo, read:org");
    }
    // The probe sends no Authorization header — the proxy attaches the
    // credential, so the client must not try to.
    expect(sentAuth).toBe("");
    expect(calledUrl).toBe("https://api.github.com/");
  });

  test("succeeds with no scopes on a 401 (host attaches no credential)", async () => {
    const outcome = await runToOutcome(
      ambientGitHubReachable({
        fetchImpl: () => Promise.resolve(githubRootResponse(401)),
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.scopes).toBeUndefined();
    }
  });

  test("a 404 is healthy, not a breakage (rate-limit style answers)", async () => {
    const outcome = await runToOutcome(
      ambientGitHubReachable({
        fetchImpl: () => Promise.resolve(githubRootResponse(404)),
      })
    );
    expect(outcome.ok).toBe(true);
  });

  test("an empty scopes header reads as absent", async () => {
    const outcome = await runToOutcome(
      ambientGitHubReachable({
        fetchImpl: () => Promise.resolve(githubRootResponse(200, "")),
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.scopes).toBeUndefined();
    }
  });

  test("a 5xx fails with the status in the detail", async () => {
    const outcome = await runToOutcome(
      ambientGitHubReachable({
        fetchImpl: () => Promise.resolve(githubRootResponse(502)),
      })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.detail).toContain("502");
    }
  });

  test("a network error is captured in the failure channel, not thrown", async () => {
    const outcome = await runToOutcome(
      ambientGitHubReachable({
        fetchImpl: () => Promise.reject(new Error("ENOTFOUND api.github.com")),
      })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.detail).toContain("ENOTFOUND");
    }
  });
});
