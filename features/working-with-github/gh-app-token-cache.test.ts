import { describe, expect, test } from "bun:test";
// A throwaway RSA key is generated at test time (never a real one) so the JWT
// signing path is exercised for real without embedding any secret.
import { generateKeyPairSync } from "node:crypto";

import { Effect } from "effect";

import type { InstallationCache } from "./gh-app-registry.ts";

import { mintInstallationToken } from "./gh-app-token-mint.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TEST_PEM_B64 = Buffer.from(
  privateKey.export({
    format: "pem",
    type: "pkcs1",
  })
).toString("base64");

/** The bare default app env — org derived from GITHUB_REPO for discovery. */
const DEFAULT_ENV = {
  GH_APP_ID: "111",
  GH_APP_PRIVATE_KEY: TEST_PEM_B64,
  GITHUB_REPO: "acme-interns/helper-bot",
} as const;

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

describe("mintInstallationToken installation cache", () => {
  test("a cache hit mints against the cached id and skips discovery", async () => {
    const { cache, calls } = makeFakeCache({ "111\nacme-interns": "77" });
    const urls: string[] = [];
    const outcome = await runToOutcome(
      mintInstallationToken({
        cache,
        env: DEFAULT_ENV,
        fetchImpl: (url) => {
          urls.push(url);
          return Promise.resolve(
            jsonResponse(
              {
                expires_at: "x",
                token: "ghs_cached",
              },
              201
            )
          );
        },
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.token).toBe("ghs_cached");
    }
    // No discovery GET; straight to the cached installation.
    expect(urls).toEqual([
      "https://api.github.com/app/installations/77/access_tokens",
    ]);
    expect(calls).toContain("get:111\nacme-interns");
    expect(calls.some((c) => c.startsWith("put:"))).toBe(false);
  });

  test("a cache miss discovers and populates the cache", async () => {
    const { cache, calls, store } = makeFakeCache();
    const outcome = await runToOutcome(
      mintInstallationToken({
        cache,
        env: DEFAULT_ENV,
        fetchImpl: (url) => {
          if (url.includes("/app/installations?")) {
            return Promise.resolve(
              jsonResponse([
                {
                  account: { login: "acme-interns" },
                  id: 88,
                },
              ])
            );
          }
          return Promise.resolve(
            jsonResponse(
              {
                expires_at: "x",
                token: "ghs_fresh",
              },
              201
            )
          );
        },
      })
    );
    expect(outcome.ok).toBe(true);
    expect(store.get("111\nacme-interns")).toBe("88");
    expect(calls).toContain("put:111\nacme-interns=88");
  });

  test("a stale cached id (token POST 404) is invalidated, re-discovered, and retried", async () => {
    const { cache, calls, store } = makeFakeCache({
      "111\nacme-interns": "stale",
    });
    const tokenPosts: string[] = [];
    const outcome = await runToOutcome(
      mintInstallationToken({
        cache,
        env: DEFAULT_ENV,
        fetchImpl: (url) => {
          if (url.includes("/app/installations?")) {
            return Promise.resolve(
              jsonResponse([
                {
                  account: { login: "acme-interns" },
                  id: 999,
                },
              ])
            );
          }
          tokenPosts.push(url);
          // The stale installation 404s; the re-discovered one succeeds.
          if (url.includes("/installations/stale/")) {
            return Promise.resolve(jsonResponse({ message: "Not Found" }, 404));
          }
          return Promise.resolve(
            jsonResponse(
              {
                expires_at: "x",
                token: "ghs_recovered",
              },
              201
            )
          );
        },
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.token).toBe("ghs_recovered");
    }
    // Tried the stale id, then the freshly discovered one.
    expect(tokenPosts).toEqual([
      "https://api.github.com/app/installations/stale/access_tokens",
      "https://api.github.com/app/installations/999/access_tokens",
    ]);
    expect(calls).toContain("delete:111\nacme-interns");
    expect(store.get("111\nacme-interns")).toBe("999");
  });

  test("a stale cached id whose re-discovery fails surfaces the ORIGINAL stale status, not the discovery noise", async () => {
    // Pre-fix: a 401/404 token POST whose re-discovery fails (the App was
    // uninstalled — zero installations) surfaced the discovery failure, hiding
    // the actionable stale status the caller matches a retry on.
    const { cache, calls } = makeFakeCache({
      "111\nacme-interns": "stale",
    });
    const tokenPosts: string[] = [];
    const outcome = await runToOutcome(
      mintInstallationToken({
        cache,
        env: DEFAULT_ENV,
        fetchImpl: (url) => {
          if (url.includes("/app/installations?")) {
            // Re-discovery finds the App uninstalled: zero installations.
            return Promise.resolve(jsonResponse([]));
          }
          tokenPosts.push(url);
          // The stale cached installation 401s (empty body — the 0-byte shape).
          return Promise.resolve(
            new Response("", { status: 401 }) as unknown as Response
          );
        },
      })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // The ORIGINAL stale error (op:http, status 401) — not op:discover.
      expect(outcome.error.op).toBe("http");
      expect(outcome.error.status).toBe(401);
      expect(outcome.error.message).toContain("HTTP 401");
    }
    // The stale row was still invalidated before the failed re-discovery.
    expect(calls).toContain("delete:111\nacme-interns");
    expect(tokenPosts).toEqual([
      "https://api.github.com/app/installations/stale/access_tokens",
    ]);
  });

  test("a poisoned EMPTY-ORG cache row is never trusted: deleted, purged, and re-discovery fails closed", async () => {
    // Pre-fix poisoning: no GITHUB_REPO → empty org key → the foreign sole
    // installation's id was cached under "".
    const { cache, calls } = makeFakeCache({ "111\n": "66" });
    const urls: string[] = [];
    const outcome = await runToOutcome(
      mintInstallationToken({
        cache,
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
      })
    );
    // The cached foreign id is never minted against; discovery fails closed.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.op).toBe("discover");
      expect(outcome.error.message).toContain("allowlist");
    }
    expect(
      urls.some((u) => u.includes("/app/installations/66/access_tokens"))
    ).toBe(false);
    // The untrusted row is deleted and siblings are swept.
    expect(calls).toContain("delete:111\n");
    expect(calls.some((c) => c.startsWith("purge:"))).toBe(true);
  });

  test("an allowlisted empty-org (sole-installation) resolution mints but is never cached", async () => {
    const { cache, calls } = makeFakeCache();
    const outcome = await runToOutcome(
      mintInstallationToken({
        cache,
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
    // The empty-org key carries no owner identity, so it must not be cached.
    expect(calls.some((c) => c.startsWith("put:"))).toBe(false);
  });
});

describe("mintInstallationToken routing notes", () => {
  test("a registered (org, purpose) notes the routing to stderr — stdout carries only the token", async () => {
    const err: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((text: string) => {
      err.push(text);
      return true;
    }) as typeof process.stderr.write;
    try {
      const outcome = await runToOutcome(
        mintInstallationToken({
          // cache:null disables the production SQLite cache. Pre-fix this
          // omitted it: the mint opened the REAL registry DB
          // (~/.config/<intern>/gh-app-registry.db) from inside the test —
          // polluting production state (its own rows were observed there)
          // and making the test depend on whatever rows it found.
          cache: null,
          env: {
            GH_APP_ALLOWED_ORGS: "acme-interns acme-corp",
            GH_APP_ID: "111",
            GH_APP_PRIVATE_KEY: TEST_PEM_B64,
            GITHUB_REPO: "acme-interns/helper-bot",
            TEAM_GH_APP_ID: "222",
            TEAM_GH_APP_PRIVATE_KEY: TEST_PEM_B64,
          },
          fetchImpl: (url: string) =>
            url.includes("/app/installations?")
              ? Promise.resolve(
                  jsonResponse([{ account: { login: "acme-corp" }, id: 55 }])
                )
              : Promise.resolve(
                  jsonResponse({ token: "ghs_reg", expires_at: "x" })
                ),
          registry: () => ({
            appIdKey: "TEAM_GH_APP_ID",
            privateKeyKey: "TEAM_GH_APP_PRIVATE_KEY",
          }),
          targetRepo: "acme-corp/widgets",
          purpose: "reviewer",
        })
      );
      // With no cache injected, the fetch fake answers both the discovery
      // page and the token POST — the mint must succeed.
      expect(outcome.ok).toBe(true);
      const notes = err.join("");
      expect(notes).toContain("acme-corp (reviewer)");
      expect(notes).toContain("TEAM_GH_APP_ID");
      expect(notes).toContain("TEAM_GH_APP_PRIVATE_KEY");
      // Never the credential VALUES, only the env key NAMES.
      expect(notes).not.toContain("222");
      // stdout of the CLI wrapper carries only the token; this note is stderr.
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test("a missing registry row notes the default-app fallback instead of routing silently", async () => {
    const err: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((text: string) => {
      err.push(text);
      return true;
    }) as typeof process.stderr.write;
    try {
      const outcome = await runToOutcome(
        mintInstallationToken({
          // cache:null — same production-DB isolation as the registered-row
          // test above; the routing NOTE under test is stderr-only.
          cache: null,
          env: {
            GH_APP_ALLOWED_ORGS: "acme-interns acme-corp",
            GH_APP_ID: "111",
            GH_APP_PRIVATE_KEY: TEST_PEM_B64,
            GITHUB_REPO: "acme-interns/helper-bot",
          },
          fetchImpl: (url: string) =>
            url.includes("/app/installations?")
              ? Promise.resolve(
                  jsonResponse([{ account: { login: "acme-corp" }, id: 44 }])
                )
              : Promise.resolve(jsonResponse({ token: "ghs_fb", expires_at: "x" })),
          registry: () => null,
          targetRepo: "acme-corp/widgets",
          purpose: "reviewer",
        })
      );
      expect(outcome.ok).toBe(true);
      const notes = err.join("");
      expect(notes).toContain("falling back to the default");
      expect(notes).toContain("acme-corp (reviewer)");
    } finally {
      process.stderr.write = origWrite;
    }
  });
});
