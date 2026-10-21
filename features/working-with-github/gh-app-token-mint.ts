/**
 * gh-app-token-mint.ts — the entrypoint convenience wrapper around `GhApp`.
 *
 * Split out of `gh-app-token.ts` to keep that file under the line cap; there
 * is no independent reuse story yet, same as `commit-flow.ts`'s split from
 * `commit-via-api.ts`.
 */

import { Effect, Layer } from "effect";

import { DEFAULT_PURPOSE, orgOf } from "./gh-app-registry.ts";

import type {
  FetchLike,
  GhAppError,
  InstallationToken,
} from "./gh-app-github-api.ts";
import type { GhAppKeyNames, InstallationCache } from "./gh-app-registry.ts";
import type { GhAppConfigDeps, RegistryResolver } from "./gh-app-token.ts";

import {
  openGhAppRegistryDb,
  resolveApp,
  sqliteInstallationCache,
} from "./gh-app-registry.ts";
import { GhApp, GhAppConfigLayer, GhAppLive } from "./gh-app-token.ts";

interface MintDeps {
  readonly clock?: () => number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: FetchLike;
  /** Target repo/org — routes to a registered app for that org when one exists. */
  readonly targetRepo?: string;
  /** Role label for the registry lookup; defaults to `default`. */
  readonly purpose?: string;
  /**
   * (org, purpose) → key-names resolver. Tests inject a fake; when omitted and a
   * `targetRepo` is given, the production SQLite registry is opened lazily.
   */
  readonly registry?: RegistryResolver;
  /**
   * Installation-id cache. Tests inject a fake; when omitted, the production
   * SQLite-backed cache is used. Pass `null` to disable caching (always discover).
   */
  readonly cache?: InstallationCache | null;
  /**
   * Override the fail-closed installation-owner allowlist. Omitted → resolved
   * from `GH_APP_ALLOWED_ORGS`, else the four-org secure default.
   */
  readonly allowedOrgs?: readonly string[];
  /** Diagnostic sink for routing decisions (which App identity a mint targets).
   *  Defaults to `process.stderr.write` — stdout stays token-only. */
  readonly diag?: (text: string) => void;
}

/**
 * One stderr line naming the App identity a mint targets — the ONLY place
 * routing is surfaced (stdout stays token-only for `$(...)` capture). "default"
 * where the caller intended a registered App is the signature of a wrong or
 * missing registry row; without this line that fallback is invisible.
 */
const formatMintRoute = (resolved: {
  readonly org: string;
  readonly purpose: string;
  readonly registered: boolean;
}): string =>
  `gh-app-token: minting as ${
    resolved.registered
      ? `registered app org=${resolved.org} purpose=${resolved.purpose}`
      : "default GH_APP_*"
  }\n`;

/**
 * Default production resolver: open the SQLite registry and resolve (org,
 * purpose). Opened lazily and closed immediately so a mint touches the DB only
 * when a target org is actually requested.
 *
 * A clean "no mapping for this (org, purpose)" is `resolveApp` returning `null`
 * — the expected, silent path to the bare default app. A *thrown* error (DB
 * unavailable, permissions, corrupt file) is a misconfiguration, not a routing
 * decision: it still degrades to `null` so minting the default app keeps
 * working, but emits a one-line stderr diagnostic (never a secret) so the
 * fallback isn't silent. It stays on stderr so `mint-token.ts`'s stdout — which
 * carries ONLY the token for `$(...)` capture — is unaffected.
 */
const defaultRegistryResolver: RegistryResolver = (org, purpose) => {
  try {
    const db = openGhAppRegistryDb();
    try {
      return resolveApp(db, org, purpose);
    } finally {
      db.close();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `gh-app-token: registry lookup for ${org} (${purpose}) failed (${detail}); falling back to the default GH_APP_*\n`,
    );
    return null;
  }
};

/**
 * Mint a token as a self-contained Effect: yields the `GhApp` service and
 * provides its layers from the (optionally faked) deps, so the returned Effect
 * has no outstanding requirement. Its only typed failure is `GhAppError`.
 *
 * With no `targetRepo`, mints the bare default app (unchanged). With one, routes
 * through the (org, purpose) registry — an injected `registry` seam in tests,
 * else the production SQLite registry.
 *
 * Callers that already have `GhApp` in context should `yield* GhApp` and call
 * `.mint()` directly; this helper is for the entrypoint shells and unit tests
 * that build the dependency graph from explicit deps.
 */
export const mintInstallationToken = (
  deps: MintDeps = {},
): Effect.Effect<InstallationToken, GhAppError> => {
  const diag = deps.diag ?? ((text) => process.stderr.write(text));
  const org = deps.targetRepo === undefined ? "" : orgOf(deps.targetRepo);
  const baseRegistry: RegistryResolver | undefined =
    deps.registry ?? (org !== "" ? defaultRegistryResolver : undefined);
  const registry: RegistryResolver | undefined =
    baseRegistry === undefined
      ? undefined
      : (requestedOrg, requestedPurpose) => {
          const keys = baseRegistry(requestedOrg, requestedPurpose);
          diag(
            formatMintRoute({
              registered: keys !== null,
              org: requestedOrg,
              purpose: requestedPurpose,
            }),
          );
          return keys;
        };
  // undefined → production SQLite cache; explicit null → caching disabled.
  const cache =
    deps.cache === null ? undefined : (deps.cache ?? sqliteInstallationCache);
  // A single combined layer (config feeding the mint service) rather than two
  // chained `Effect.provide` calls, which the Effect language service flags
  // (multipleEffectProvide) as risking service-lifecycle surprises.
  const configDeps: GhAppConfigDeps = {
    allowedOrgs: deps.allowedOrgs,
    cache,
    clock: deps.clock,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
    org: deps.targetRepo,
    purpose: deps.purpose,
    registry,
  };
  const layer = GhAppLive.pipe(Layer.provide(GhAppConfigLayer(configDeps)));
  return Effect.gen(function* () {
    const app = yield* GhApp;
    return yield* app.mint();
  }).pipe(Effect.provide(layer));
};
