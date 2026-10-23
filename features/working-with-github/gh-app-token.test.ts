import { describe, expect, test } from "bun:test";
// A throwaway RSA key is generated at test time (never a real one) so the JWT
// signing path is exercised for real without embedding any secret.
import { generateKeyPairSync } from "node:crypto";

import { Effect } from "effect";

import type { GhAppKeyNames, InstallationCache } from "./gh-app-registry.ts";

import { mintInstallationToken } from "./gh-app-token-mint.ts";
import { GhAppError, readGhAppCredentials } from "./gh-app-token.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TEST_PEM_B64 = Buffer.from(
  privateKey.export({
    format: "pem",
    type: "pkcs1",
  })
).toString("base64");

/** The bare default app env — no installation id; the org comes from GITHUB_REPO. */
const DEFAULT_ENV = {
  GH_APP_ID: "111",
  GH_APP_PRIVATE_KEY: TEST_PEM_B64,
  GITHUB_REPO: "acme-interns/helper-bot",
} as const;

/** A registered app's env, under arbitrary Ori-injected key names. */
const TEAM_ENV = {
  GH_APP_ALLOWED_ORGS: "acme-interns acme-corp",
  ...DEFAULT_ENV,
  TEAM_GH_APP_ID: "222",
  TEAM_GH_APP_PRIVATE_KEY: TEST_PEM_B64,
} as const;

/** A registry resolver backed by a plain map, keyed by `org\npurpose`. */
const fakeRegistry =
  (rows: Record<string, GhAppKeyNames>) =>
  (org: string, purpose: string): GhAppKeyNames | null =>
    rows[`${org}\n${purpose}`] ?? null;

type Outcome<A, E> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: E };

const runToOutcome = <A, E>(
  effect: Effect.Effect<A, E>
): Promise<Outcome<A, E>> =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (error) => ({
          error,
          ok: false as const,
        }),
        onSuccess: (value) => ({
          ok: true as const,
          value,
        }),
      })
    )
  );

const jsonResponse = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

/** An in-memory InstallationCache fake, keyed by `appId\norg`, with a call log. */
const makeFakeCache = (
  seed: Record<string, string> = {}
): {
  readonly cache: InstallationCache;
  readonly calls: string[];
  readonly store: Map<string, string>;
} => {
  const store = new Map<string, string>(Object.entries(seed));
  const calls: string[] = [];
  return {
    calls,
    cache: {
      delete: (appId: string, org: string): void => {
        calls.push(`delete:${appId}\n${org}`);
        store.delete(`${appId}\n${org}`);
      },
      get: (appId: string, org: string): string | null => {
        calls.push(`get:${appId}\n${org}`);
        return store.get(`${appId}\n${org}`) ?? null;
      },
      purge: (allowedOrgs: Iterable<string>): number => {
        const allowed = new Set(
          Array.from(allowedOrgs, (login) => login.trim().toLowerCase())
        );
        let removed = 0;
        for (const composite of Array.from(store.keys())) {
          const org = composite.split("\n")[1] ?? "";
          if (org === "" || !allowed.has(org.toLowerCase())) {
            store.delete(composite);
            removed += 1;
          }
        }
        calls.push(`purge:${removed}`);
        return removed;
      },
      put: (appId: string, org: string, installationId: string): void => {
        calls.push(`put:${appId}\n${org}=${installationId}`);
        store.set(`${appId}\n${org}`, installationId);
      },
    },
    store,
  };
};

// ─── readGhAppCredentials — registry resolution ─────────────────────────────

describe("readGhAppCredentials with a registry", () => {
  test("no org resolves the bare default app, org derived from GITHUB_REPO", async () => {
    const outcome = await runToOutcome(
      readGhAppCredentials({
        env: TEAM_ENV,
        registry: fakeRegistry({}),
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.appId).toBe("111");
      // No pinned installation; org derived from GITHUB_REPO for discovery.
      expect(outcome.value.org).toBe("acme-interns");
    }
  });

  test("a registered (org, purpose) reads the values from the named env vars, no installation", async () => {
    const registry = fakeRegistry({
      "acme-corp\nreviewer": {
        appIdKey: "TEAM_GH_APP_ID",
        privateKeyKey: "TEAM_GH_APP_PRIVATE_KEY",
      },
    });
    const outcome = await runToOutcome(
      readGhAppCredentials({
        env: TEAM_ENV,
        org: "acme-corp/web",
        purpose: "reviewer",
        registry,
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.appId).toBe("222");
      expect(outcome.value.org).toBe("acme-corp");
    }
  });

  test("falls back to the default app but still discovers against the TARGET org", async () => {
    const outcome = await runToOutcome(
      readGhAppCredentials({
        env: TEAM_ENV,
        org: "UnknownOrg/x",
        purpose: "reviewer",
        registry: fakeRegistry({}),
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.appId).toBe("111");
      // Default app credentials, but discovery targets the requested org (not
      // GITHUB_REPO) so the default app can still reach the target's installation.
      expect(outcome.value.org).toBe("UnknownOrg");
    }
  });

  test("with a target org but no registry configured, uses the default app against the target org", async () => {
    const outcome = await runToOutcome(
      readGhAppCredentials({
        env: TEAM_ENV,
        org: "OtherOrg/repo",
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.appId).toBe("111");
      expect(outcome.value.org).toBe("OtherOrg");
    }
  });

  test("fails naming the missing key when a registered env var is absent — never the value", async () => {
    const registry = fakeRegistry({
      "acme-corp\ndefault": {
        appIdKey: "TEAM_GH_APP_ID",
        privateKeyKey: "MISSING_KEY",
      },
    });
    const outcome = await runToOutcome(
      readGhAppCredentials({
        env: TEAM_ENV,
        org: "acme-corp",
        registry,
      })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.op).toBe("config");
      expect(outcome.error.message).toContain("MISSING_KEY");
      expect(outcome.error.message).not.toContain("222");
    }
  });
});

// ─── mintInstallationToken — discovery path for registered apps ─────────────

describe("mintInstallationToken installation discovery", () => {
  test("discovers the installation for the org, then POSTs to it", async () => {
    const registry = fakeRegistry({
      "acme-corp\nreviewer": {
        appIdKey: "TEAM_GH_APP_ID",
        privateKeyKey: "TEAM_GH_APP_PRIVATE_KEY",
      },
    });
    const urls: string[] = [];
    const outcome = await runToOutcome(
      mintInstallationToken({
        clock: () => 1_700_000_000_000,
        env: TEAM_ENV,
        fetchImpl: (url) => {
          urls.push(url);
          if (url.includes("/app/installations?")) {
            return Promise.resolve(
              jsonResponse([
                {
                  account: { login: "SomeoneElse" },
                  id: 1,
                },
                {
                  account: { login: "acme-corp" },
                  id: 4242,
                },
              ])
            );
          }
          return Promise.resolve(
            jsonResponse(
              {
                expires_at: "2026-01-01T00:00:00Z",
                token: "ghs_team",
              },
              201
            )
          );
        },
        cache: null,
        purpose: "reviewer",
        registry,
        targetRepo: "acme-corp/widgets",
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.token).toBe("ghs_team");
    }
    // It listed installations, matched the org, then minted against installation 4242.
    expect(urls.some((u) => u.includes("/app/installations?per_page="))).toBe(
      true
    );
    expect(urls).toContain(
      "https://api.github.com/app/installations/4242/access_tokens"
    );
  });

  test("fails with op:discover when no installation matches the org", async () => {
    const registry = fakeRegistry({
      "acme-corp\ndefault": {
        appIdKey: "TEAM_GH_APP_ID",
        privateKeyKey: "TEAM_GH_APP_PRIVATE_KEY",
      },
    });
    const outcome = await runToOutcome(
      mintInstallationToken({
        env: TEAM_ENV,
        fetchImpl: (url) => {
          if (url.includes("/app/installations?")) {
            return Promise.resolve(
              jsonResponse([
                {
                  account: { login: "SomeoneElse" },
                  id: 1,
                },
              ])
            );
          }
          return Promise.resolve(jsonResponse({ token: "unused" }, 201));
        },
        cache: null,
        registry,
        targetRepo: "acme-corp/widgets",
      })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(GhAppError);
      expect(outcome.error.op).toBe("discover");
      expect(outcome.error.message).toContain("acme-corp");
    }
  });

  test("with no targetRepo, mints the default app by discovering its GITHUB_REPO-org installation", async () => {
    const urls: string[] = [];
    const outcome = await runToOutcome(
      mintInstallationToken({
        cache: null,
        clock: () => 1_700_000_000_000,
        env: DEFAULT_ENV,
        fetchImpl: (url) => {
          urls.push(url);
          if (url.includes("/app/installations?")) {
            return Promise.resolve(
              jsonResponse([
                {
                  account: { login: "acme-interns" },
                  id: 55,
                },
              ])
            );
          }
          return Promise.resolve(
            jsonResponse(
              {
                expires_at: "x",
                token: "ghs_default",
              },
              201
            )
          );
        },
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.token).toBe("ghs_default");
    }
    // Discovered the acme-interns installation (from GITHUB_REPO), then minted against it.
    expect(urls.some((u) => u.includes("/app/installations?per_page="))).toBe(
      true
    );
    expect(urls).toContain(
      "https://api.github.com/app/installations/55/access_tokens"
    );
  });

  test("with no org derivable, falls back to the App's sole installation", async () => {
    const urls: string[] = [];
    const outcome = await runToOutcome(
      mintInstallationToken({
        cache: null,
        clock: () => 1_700_000_000_000,
        // No GITHUB_REPO → empty org → sole-installation fallback.
        env: {
          GH_APP_ALLOWED_ORGS: "acme-interns",
          GH_APP_ID: "111",
          GH_APP_PRIVATE_KEY: TEST_PEM_B64,
        },
        fetchImpl: (url) => {
          urls.push(url);
          if (url.includes("/app/installations?")) {
            return Promise.resolve(
              jsonResponse([
                {
                  account: { login: "acme-interns" },
                  id: 99,
                },
              ])
            );
          }
          return Promise.resolve(
            jsonResponse(
              {
                expires_at: "x",
                token: "ghs_sole",
              },
              201
            )
          );
        },
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.token).toBe("ghs_sole");
    }
    expect(urls).toContain(
      "https://api.github.com/app/installations/99/access_tokens"
    );
  });

  test("with no org and several installations, fails op:discover as ambiguous", async () => {
    const outcome = await runToOutcome(
      mintInstallationToken({
        cache: null,
        env: {
          GH_APP_ID: "111",
          GH_APP_PRIVATE_KEY: TEST_PEM_B64,
        },
        fetchImpl: (url) => {
          if (url.includes("/app/installations?")) {
            return Promise.resolve(
              jsonResponse([
                {
                  account: { login: "OrgA" },
                  id: 1,
                },
                {
                  account: { login: "OrgB" },
                  id: 2,
                },
              ])
            );
          }
          return Promise.resolve(jsonResponse({ token: "unused" }, 201));
        },
      })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.op).toBe("discover");
      expect(outcome.error.message).toContain("2 installations");
    }
  });

  test("REJECTS a foreign single installation with an empty org (fails closed, no mint)", async () => {
    let mintAttempted = false;
    const outcome = await runToOutcome(
      mintInstallationToken({
        cache: null,
        // No GITHUB_REPO → empty org → sole-installation fallback path.
        env: {
          GH_APP_ALLOWED_ORGS: "acme-interns",
          GH_APP_ID: "111",
          GH_APP_PRIVATE_KEY: TEST_PEM_B64,
        },
        fetchImpl: (url) => {
          if (url.includes("/app/installations?")) {
            return Promise.resolve(
              jsonResponse([
                {
                  // The public-App attack: a foreign org installed the App.
                  account: { login: "kolfadser1" },
                  id: 66,
                },
              ])
            );
          }
          mintAttempted = true;
          return Promise.resolve(jsonResponse({ token: "leaked" }, 201));
        },
      })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.op).toBe("discover");
      expect(outcome.error.message).toContain("kolfadser1");
      expect(outcome.error.message).toContain("allowlist");
    }
    // The token endpoint was never reached for the foreign installation.
    expect(mintAttempted).toBe(false);
  });

  test("selects the allowlisted installation and NEVER the foreign one alongside it", async () => {
    const urls: string[] = [];
    const outcome = await runToOutcome(
      mintInstallationToken({
        cache: null,
        clock: () => 1_700_000_000_000,
        env: DEFAULT_ENV,
        fetchImpl: (url) => {
          urls.push(url);
          if (url.includes("/app/installations?")) {
            return Promise.resolve(
              jsonResponse([
                {
                  account: { login: "kolfadser1" },
                  id: 13,
                },
                {
                  account: { login: "acme-interns" },
                  id: 77,
                },
              ])
            );
          }
          return Promise.resolve(
            jsonResponse(
              {
                expires_at: "x",
                token: "ghs_valid",
              },
              201
            )
          );
        },
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.token).toBe("ghs_valid");
    }
    // Minted against the allowlisted installation only; the foreign id 13 is
    // never POSTed to.
    expect(urls).toContain(
      "https://api.github.com/app/installations/77/access_tokens"
    );
    expect(
      urls.some((u) => u.includes("/app/installations/13/access_tokens"))
    ).toBe(false);
  });

  test("still resolves normally when the matched org is allowlisted", async () => {
    const urls: string[] = [];
    const outcome = await runToOutcome(
      mintInstallationToken({
        cache: null,
        clock: () => 1_700_000_000_000,
        env: DEFAULT_ENV,
        fetchImpl: (url) => {
          urls.push(url);
          if (url.includes("/app/installations?")) {
            return Promise.resolve(
              jsonResponse([
                {
                  account: { login: "acme-interns" },
                  id: 42,
                },
              ])
            );
          }
          return Promise.resolve(
            jsonResponse(
              {
                expires_at: "x",
                token: "ghs_ok",
              },
              201
            )
          );
        },
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.token).toBe("ghs_ok");
    }
    expect(urls).toContain(
      "https://api.github.com/app/installations/42/access_tokens"
    );
  });

  test("a poisoned cache row (foreign org key) is ignored and purged, never minted against", async () => {
    // A pre-incident cache poisoned with a foreign org → foreign installation id.
    const { cache, calls } = makeFakeCache({
      "111\nkolfadser1": "66",
      "111\nacme-interns": "77",
    });
    const urls: string[] = [];
    const outcome = await runToOutcome(
      mintInstallationToken({
        cache,
        clock: () => 1_700_000_000_000,
        // An explicit registry (here: no rows) keeps the mint OFF the
        // production SQLite registry DB. Pre-fix this was omitted, so
        // `mintInstallationToken({ targetRepo })` wired
        // `defaultRegistryResolver` → `openGhAppRegistryDb()` → the real
        // `~/.config/<intern>/gh-app-registry.db` from inside the test
        // (verified with a GH_APP_REGISTRY_DIR canary): the resolver is only
        // skipped when `targetRepo` is absent, and the registry fallback row
        // it reads there belongs to whatever the operator last registered —
        // a production-state touch and a flakiness seam, the same class as
        // #127 closed for the routing-note tests via `cache: null`.
        registry: () => null,
        // Target the foreign org so the poisoned row would be the cache key hit.
        env: {
          GH_APP_ID: "111",
          GH_APP_PRIVATE_KEY: TEST_PEM_B64,
        },
        fetchImpl: (url) => {
          urls.push(url);
          if (url.includes("/app/installations?")) {
            return Promise.resolve(
              jsonResponse([
                {
                  account: { login: "kolfadser1" },
                  id: 66,
                },
              ])
            );
          }
          return Promise.resolve(jsonResponse({ token: "leaked" }, 201));
        },
        targetRepo: "kolfadser1/evil",
      })
    );
    // The cached foreign row is dropped, discovery re-runs, and discovery itself
    // fails closed on the foreign owner — no token is ever minted.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.op).toBe("discover");
      expect(outcome.error.message).toContain("allowlist");
    }
    // The poisoned row was deleted and a purge swept siblings.
    expect(calls).toContain("delete:111\nkolfadser1");
    expect(calls.some((c) => c.startsWith("purge:"))).toBe(true);
    // The foreign cached id 66 was never POSTed to as a trusted cache hit.
    expect(
      urls.some((u) => u.includes("/app/installations/66/access_tokens"))
    ).toBe(false);
  });

  test("fails op:config (before any network) when the App id is not a positive integer", async () => {
    let fetched = false;
    const outcome = await runToOutcome(
      mintInstallationToken({
        cache: null,
        // GH_APP_ID is non-numeric → Number(...) would be NaN → JSON null iss.
        env: {
          GH_APP_ID: "not-a-number",
          GH_APP_PRIVATE_KEY: TEST_PEM_B64,
          GITHUB_REPO: "acme-interns/helper-bot",
        },
        fetchImpl: () => {
          fetched = true;
          return Promise.resolve(jsonResponse({}, 201));
        },
      })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.op).toBe("config");
      expect(outcome.error.message).toContain("positive integer");
      // Never leaks nor even reaches the network.
      expect(outcome.error.message).toContain("not-a-number");
    }
    expect(fetched).toBe(false);
  });
});
