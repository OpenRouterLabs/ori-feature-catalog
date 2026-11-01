/**
 * gh-app-token-mint.ts — the entrypoint convenience wrapper around `GhApp`.
 *
 * Split out of `gh-app-token.ts` to keep that file under the line cap; there
 * is no independent reuse story yet, same as `commit-flow.ts`'s split from
 * `commit-via-api.ts`.
 */

import { Effect, Layer } from "effect";

import type {
  FetchLike,
  InstallationToken,
} from "./gh-app-github-api.ts";
import type { InstallationCache } from "./gh-app-registry.ts";
import type { GhAppKeyNames } from "./gh-app-registry.ts";
import type { GhAppConfigDeps, RegistryResolver } from "./gh-app-token.ts";

import {
  DEFAULT_PURPOSE,
  openGhAppRegistryDb,
  orgOf,
  resolveApp,
  sqliteInstallationCache,
} from "./gh-app-registry.ts";
import { GhAppError } from "./gh-app-github-api.ts";
import { GhApp, GhAppConfigLayer, GhAppLive } from "./gh-app-token.ts";

/**
 * Wrap a registry resolver with a one-line stderr note of the routing
 * decision it makes — key NAMES only, never a credential value. It goes to
 * stderr so `mint-token.ts`'s stdout, which carries ONLY the token for
 * `$(...)` capture, stays clean. A wrong or missing registry row is then
 * visible as an explicit "falling back to the default GH_APP_*" decision
 * instead of a silent identity swap.
 */
const notedRegistryResolver = (
  resolver: RegistryResolver
): RegistryResolver => {
  return (org: string, purpose: string): GhAppKeyNames | null => {
    const keys = resolver(org, purpose);
    process.stderr.write(
      keys === null
        ? `gh-app-token: no registered app for ${org} (${purpose}); falling back to the default GH_APP_*\n`
        : `gh-app-token: routing ${org} (${purpose}) to the app registered under ${keys.appIdKey} / ${keys.privateKeyKey}\n`
    );
    return keys;
  };
};


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
   * from `GH_APP_ALLOWED_ORGS`, else the `GITHUB_REPO` owner.
   */
  readonly allowedOrgs?: readonly string[];
}

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
      `gh-app-token: registry lookup for ${org} (${purpose}) failed (${detail}); falling back to the default GH_APP_*\n`
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
  deps: MintDeps = {}
): Effect.Effect<InstallationToken, GhAppError> => {
  const registry =
    deps.registry ??
    (deps.targetRepo !== undefined && deps.targetRepo !== ""
      ? defaultRegistryResolver
      : undefined);
  const noted =
    registry !== undefined ? notedRegistryResolver(registry) : undefined;
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
    registry: noted,
  };
  const layer = GhAppLive.pipe(Layer.provide(GhAppConfigLayer(configDeps)));
  return Effect.gen(function* () {
    const app = yield* GhApp;
    return yield* app.mint();
  }).pipe(Effect.provide(layer));
};

/**
 * A token a caller authenticates with. `expiresAt` is known only for a token
 * minted from a registered alternate App; the host-rotated `GH_TOKEN` carries
 * no expiry.
 */
export interface GitHubToken {
  readonly token: string;
  readonly expiresAt?: string;
}

const readRotatedToken = (
  env: Readonly<Record<string, string | undefined>>
): Effect.Effect<GitHubToken, GhAppError> => {
  const token = (env.GH_TOKEN ?? "").trim();
  return token === ""
    ? Effect.fail(
        new GhAppError({
          message:
            "GH_TOKEN is not set — the default App's token is rotated by the host and injected as GH_TOKEN; it is never minted here",
          op: "config",
        })
      )
    : Effect.succeed({ token });
};

/**
 * The token every caller should use. The default App's token is rotated by the
 * host on a cadence (minting per run hit GitHub's rate limits), so it is read
 * from `GH_TOKEN`. Only an `(org, purpose)` that resolves to a registered
 * alternate App still mints, since the host rotates no token for it — and so
 * does a target in an org OTHER than the `GITHUB_REPO` owner: the rotated
 * token is the installation token of the own org's installation, which never
 * reaches another account, so handing it back made every call 404. That
 * target mints the default App against its own installation, allowlist-gated
 * by `GH_APP_ALLOWED_ORGS` (fail-closed for an org outside it).
 */
export const resolveGitHubToken = (
  deps: MintDeps = {}
): Effect.Effect<GitHubToken, GhAppError> =>
  Effect.suspend(() => {
    // oxlint-disable-next-line node/no-process-env -- default deps seam; callers pass a fake env in tests.
    const env = deps.env ?? process.env;
    const org =
      deps.targetRepo === undefined ? "" : orgOf(deps.targetRepo);
    if (org === "") {
      return readRotatedToken(env);
    }
    const purpose = deps.purpose ?? DEFAULT_PURPOSE;
    const keys = (deps.registry ?? defaultRegistryResolver)(org, purpose);
    if (keys === null) {
      const ownOrg = orgOf(env.GITHUB_REPO ?? "").toLowerCase();
      if (ownOrg !== "" && org.toLowerCase() !== ownOrg) {
        process.stderr.write(
          `gh-app-token: ${org} is outside the GITHUB_REPO org (${ownOrg}) the host-rotated GH_TOKEN covers; minting the default App for ${org}'s installation\n`
        );
        return mintInstallationToken({ ...deps, registry: () => null });
      }
      process.stderr.write(
        `gh-app-token: no registered app for ${org} (${purpose}); using the host-rotated GH_TOKEN\n`
      );
      return readRotatedToken(env);
    }
    return mintInstallationToken({ ...deps, registry: () => keys });
  });
