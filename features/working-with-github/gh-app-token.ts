/**
 * gh-app-token.ts — mint a short-lived GitHub App installation token.
 *
 * The single source of truth for this intern's GitHub authentication, modelled
 * the Effect (v4) way as a service/layer design:
 *
 *   - `GhAppConfig` is a `Context.Service` holding the App credentials + the
 *     injectable `fetch`/`clock` seam. `GhAppConfigLive` reads them from
 *     `process.env` (injected by systemd); tests provide a fake through the same
 *     Layer via `GhAppConfigLayer`.
 *   - `GhApp` is the token-minting service. Any Effect can `yield* GhApp` to
 *     obtain it; its requirement is tracked in the Effect's `R` channel until a
 *     Layer provides it. `GhAppLive` builds it on top of `GhAppConfig`.
 *
 * The low-level GitHub plumbing (the typed `GhAppError`, JWT signing, response
 * parsing, installation discovery, the access-token POST) lives in
 * `gh-app-github-api.ts`; this file composes it into the Effect service graph.
 *
 * Every method returns an `Effect` whose only typed failure is `GhAppError`
 * (carrying the failing `op` so a failed mint is diagnosable from the logs).
 *
 * Nothing here ever persists the token. Callers mint on demand and inject the
 * token ephemerally — `scripts/mint-token.ts` prints one to stdout for
 * `GH_TOKEN=$(...)` injection into a single `gh`/`git`/`curl` call, and
 * `scripts/commit-via-api.ts` mints internally for one signed commit. The
 * `gh-auth-health` schedule only verifies a mint succeeds. The only secret at
 * rest on the VM is the App private key in the service env — the token is
 * always derived on demand, so there is no `~/.config/gh/hosts.yml`, no token
 * embedded in a git remote URL, and no token file.
 *
 * A single App installation only covers the orgs it's installed on, so the
 * default `GH_APP_*` token can't reach repos in other orgs (or act under a
 * different role in the same org). `mintInstallationToken({ targetRepo, purpose })`
 * resolves an alternate App via the (org, purpose) registry (`gh-app-registry.ts`)
 * and discovers its installation; with no `targetRepo` it mints the bare default,
 * byte-for-byte as before.
 */

import { Context, Effect, Exit, Layer, Option } from "effect";

import type {
  FetchLike,
  GhAppCredentials,
  InstallationToken,
} from "./gh-app-github-api.ts";
import type { GhAppKeyNames, InstallationCache } from "./gh-app-registry.ts";

import {
  discoverInstallationId,
  GhAppError,
  isAllowlistedOrg,
  requestInstallationToken,
  resolveAllowedOrgs,
  signAppJwt,
} from "./gh-app-github-api.ts";
import { DEFAULT_PURPOSE, orgOf } from "./gh-app-registry.ts";

export type {
  GhAppCredentials,
  InstallationToken,
} from "./gh-app-github-api.ts";
export type { InstallationCache } from "./gh-app-registry.ts";
export { GhAppError } from "./gh-app-github-api.ts";

/**
 * Resolve the (org, purpose) → env-key-names mapping. Injected so tests supply a
 * fake and the production path opens the SQLite registry lazily (only when a
 * target org is actually requested). Returns null to fall back to the bare
 * default app.
 */
export type RegistryResolver = (
  org: string,
  purpose: string
) => GhAppKeyNames | null;

// #region Constants

/** Names of the env vars the default App flow reads, surfaced for precise error text. */
const GH_APP_ENV_KEYS = ["GH_APP_ID", "GH_APP_PRIVATE_KEY"] as const;

/** `Date.now()` gives milliseconds; GitHub's JWT `iat`/`exp` want seconds. */
const MS_PER_SECOND = 1000;

// #endregion

// #region Config service

/**
 * The credentials + injectable effects service. Yield it inside any Effect to
 * read the config; the requirement shows up in the Effect's `R` channel until a
 * Layer provides it. `fetchImpl`/`clock` are carried here so a unit test drives
 * the whole flow with a fake fetch and a fixed clock, with no network.
 */
interface GhAppConfigShape {
  readonly credentials: GhAppCredentials;
  readonly fetchImpl: FetchLike;
  readonly clock: () => number;
  /** Persistent installation-id cache; undefined → always discover (no caching). */
  readonly cache?: InstallationCache;
  /**
   * Lower-cased set of installation-owner logins a token may be minted against.
   * Resolved fail-closed from `GH_APP_ALLOWED_ORGS`, else the `GITHUB_REPO`
   * owner; every
   * discovery and cache path is checked against it.
   */
  readonly allowedOrgs: Set<string>;
}

class GhAppConfig extends Context.Service<GhAppConfig, GhAppConfigShape>()(
  "GhAppConfig"
) {}

/** Options for {@link readGhAppCredentials}. All optional — the bare call reads the default app. */
export interface ReadCredentialsOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Target org (or a repo string, from which the org is derived). */
  readonly org?: string;
  /** Role label; defaults to `default`. */
  readonly purpose?: string;
  /** (org, purpose) → key-names resolver; when omitted, only the bare default app is available. */
  readonly registry?: RegistryResolver;
}

/**
 * Read the bare default app's credentials (`GH_APP_ID` / `GH_APP_PRIVATE_KEY`).
 * There is no pinned installation id — the mint flow discovers the installation,
 * matching `targetOrg` when given (the caller's `targetRepo` org, even when that
 * org has no registered app), else the `GITHUB_REPO` org, else the App's sole
 * installation.
 */
const readDefaultCredentials = (
  env: Readonly<Record<string, string | undefined>>,
  targetOrg?: string
): Effect.Effect<GhAppCredentials, GhAppError> => {
  const appId = env.GH_APP_ID;
  const privateKeyBase64 = env.GH_APP_PRIVATE_KEY;
  const missing = GH_APP_ENV_KEYS.filter((key) => {
    const value = env[key];
    return value === undefined || value === "";
  });
  if (
    missing.length > 0 ||
    appId === undefined ||
    privateKeyBase64 === undefined
  ) {
    return Effect.fail(
      new GhAppError({
        message: `Missing GitHub App env var(s): ${missing.join(", ")}`,
        op: "config",
      })
    );
  }
  // Discovery org: the explicit target (so `mintInstallationToken({ targetRepo })`
  // reaches the target org even when it has no registered app), else GITHUB_REPO,
  // else empty → the App's sole installation.
  const fromRepo =
    env.GITHUB_REPO !== undefined && env.GITHUB_REPO !== ""
      ? orgOf(env.GITHUB_REPO)
      : "";
  const org =
    targetOrg !== undefined && targetOrg !== "" ? targetOrg : fromRepo;
  return Effect.succeed({
    appId,
    org,
    privateKeyBase64,
  });
};

/** Read a registry-resolved app's credentials by env-key *names*; installation is discovered later. */
const readRegisteredCredentials = (
  env: Readonly<Record<string, string | undefined>>,
  keys: GhAppKeyNames,
  org: string
): Effect.Effect<GhAppCredentials, GhAppError> => {
  const appId = env[keys.appIdKey];
  const privateKeyBase64 = env[keys.privateKeyKey];
  const missing = [
    ...(appId === undefined || appId === "" ? [keys.appIdKey] : []),
    ...(privateKeyBase64 === undefined || privateKeyBase64 === ""
      ? [keys.privateKeyKey]
      : []),
  ];
  if (
    missing.length > 0 ||
    appId === undefined ||
    privateKeyBase64 === undefined
  ) {
    return Effect.fail(
      new GhAppError({
        message: `Missing GitHub App env var(s): ${missing.join(", ")}`,
        op: "config",
      })
    );
  }
  // No installationId — the mint flow discovers it for `org`.
  return Effect.succeed({
    appId,
    org,
    privateKeyBase64,
  });
};

/**
 * Resolve the App credentials as an Effect. With no `org` (or when the registry
 * resolves nothing) this is byte-for-byte the original bare-default read. With a
 * registered `(org, purpose)` it reads the values from the env keys the registry
 * names (installation discovered at mint time). Failures are a `config`
 * `GhAppError` naming the missing key(s) — names only, never their values.
 */
export const readGhAppCredentials = (
  options: ReadCredentialsOptions = {}
): Effect.Effect<GhAppCredentials, GhAppError> =>
  Effect.suspend(() => {
    // oxlint-disable-next-line node/no-process-env -- default deps seam; callers pass a fake env in tests.
    const env = options.env ?? process.env;
    const rawOrg = options.org;
    if (rawOrg === undefined || rawOrg === "") {
      return readDefaultCredentials(env);
    }
    // A target org was supplied — the default app should discover against IT
    // (not GITHUB_REPO) whenever we fall back, so it can still reach the target
    // org's installation when no registered app matches.
    const org = orgOf(rawOrg);
    if (options.registry === undefined) {
      return readDefaultCredentials(env, org);
    }
    const purpose = options.purpose ?? DEFAULT_PURPOSE;
    const keys = options.registry(org, purpose);
    if (keys === null) {
      return readDefaultCredentials(env, org);
    }
    return readRegisteredCredentials(env, keys, org);
  });

/** Explicit deps for {@link GhAppConfigLayer} — the seam tests inject fakes through. */
export interface GhAppConfigDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: FetchLike;
  readonly clock?: () => number;
  /** Target org/repo — routes to a registered app when the registry has a match. */
  readonly org?: string;
  /** Role label for registry lookup; defaults to `default`. */
  readonly purpose?: string;
  /** (org, purpose) → key-names resolver; omitted → only the bare default app is used. */
  readonly registry?: RegistryResolver;
  /** Persistent installation-id cache; omitted → always discover (no caching). */
  readonly cache?: InstallationCache;
  /**
   * Override the fail-closed installation-owner allowlist. Omitted → resolved
   * from `GH_APP_ALLOWED_ORGS`, else the `GITHUB_REPO` owner (fail-closed).
   */
  readonly allowedOrgs?: readonly string[];
}

/**
 * Build a `GhAppConfig` layer from explicit deps — the seam tests provide a fake
 * fetch/clock/env through. `GhAppConfigLive` is the production specialisation.
 */
export const GhAppConfigLayer = (
  deps: GhAppConfigDeps
): Layer.Layer<GhAppConfig, GhAppError> => {
  // oxlint-disable-next-line node/no-process-env -- default deps seam; callers pass a fake env in tests.
  const env = deps.env ?? process.env;
  const allowedOrgs = resolveAllowedOrgs(deps.allowedOrgs, env);
  return Layer.effect(
    GhAppConfig,
    readGhAppCredentials({
      env,
      org: deps.org,
      purpose: deps.purpose,
      registry: deps.registry,
    }).pipe(
      Effect.map((credentials) => ({
        allowedOrgs,
        cache: deps.cache,
        clock: deps.clock ?? Date.now,
        credentials,
        fetchImpl: deps.fetchImpl ?? fetch,
      }))
    )
  );
};

/** Layer providing `GhAppConfig` from the live process env, real fetch + clock. */
const GhAppConfigLive: Layer.Layer<GhAppConfig, GhAppError> = GhAppConfigLayer(
  {}
);

// #endregion

// #region Mint service

interface GhAppShape {
  /** Mint a fresh installation token, or fail with a typed `GhAppError`. */
  readonly mint: () => Effect.Effect<InstallationToken, GhAppError>;
}

/**
 * The `GhApp` service key. Yield it inside any `Effect.gen` to obtain the
 * minter; the requirement shows up in the Effect's `R` channel until a Layer
 * provides it.
 */
export class GhApp extends Context.Service<GhApp, GhAppShape>()("GhApp") {}

const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
/** A stale cached installation surfaces as a 404 (installation gone) or 401 on the token POST. */
const STALE_INSTALLATION_STATUSES = new Set([
  HTTP_UNAUTHORIZED,
  HTTP_NOT_FOUND,
]);

/** Build the mint service from a concrete config. */
const makeGhApp = (config: GhAppConfigShape): GhAppShape => {
  const org = config.credentials.org ?? "";
  const { appId } = config.credentials;
  const { allowedOrgs } = config;

  // Discover the installation id, matching the target org (registry-resolved
  // app, or the default app's GITHUB_REPO org); an empty org falls back to the
  // App's sole installation. Discovery fails closed on a non-allowlisted owner.
  // Cache the result so later mints skip the GET — except for the empty-org
  // sole-installation fallback: its cache key carries no owner identity, so a
  // cached id cannot be re-checked against the allowlist. It is never cached;
  // every empty-org mint runs (fail-closed) discovery.
  const discoverAndCache = (jwt: string): Effect.Effect<string, GhAppError> =>
    discoverInstallationId(config.fetchImpl, jwt, org, allowedOrgs).pipe(
      Effect.tap((installationId) =>
        Effect.sync(() => {
          if (org !== "") {
            config.cache?.put(appId, org, installationId);
          }
        })
      )
    );

  // Read the cache fail-closed. Two kinds of untrusted row exist, both possibly
  // poisoned by the public-App incident: a row whose non-empty org key is not
  // allowlisted, and any empty-org row (its key carries no owner identity, so
  // the allowlist cannot vouch for the stored id). Either is treated as a miss,
  // deleted, and siblings are swept via `purge`.
  const readTrustedCache = (): string | null => {
    const cached = config.cache?.get(appId, org) ?? null;
    if (
      cached !== null &&
      (org === "" || !isAllowlistedOrg(org, allowedOrgs))
    ) {
      config.cache?.delete(appId, org);
      config.cache?.purge(allowedOrgs);
      return null;
    }
    return cached;
  };

  const mint = (): Effect.Effect<InstallationToken, GhAppError> =>
    Effect.gen(function* () {
      const nowSeconds = Math.floor(config.clock() / MS_PER_SECOND);
      const jwt = yield* signAppJwt(config.credentials, nowSeconds);

      const cached = readTrustedCache();
      if (cached === null) {
        // Cache miss: discover, populate the cache, mint.
        const installationId = yield* discoverAndCache(jwt);
        return yield* requestInstallationToken(
          config.fetchImpl,
          jwt,
          installationId
        );
      }

      // Cache hit: mint against it, but a cached id can go stale (App
      // reinstalled) — on a 401/404 invalidate, re-discover, and retry once.
      // The re-discovery is wrapped in `Effect.either` so a 401/404 that
      // re-discovery cannot resolve (e.g. the App was uninstalled and has zero
      // installations now) surfaces the ORIGINAL stale status — the actionable
      // "reinstall the App / clear the cache" signal — instead of replacing it
      // with a discovery failure that hides the 401/404.
      return yield* requestInstallationToken(config.fetchImpl, jwt, cached).pipe(
        Effect.catchIf(
          (error) =>
            error.op === "http" &&
            error.status !== undefined &&
            STALE_INSTALLATION_STATUSES.has(error.status),
          (stale) =>
            Effect.gen(function* () {
              config.cache?.delete(appId, org);
              const reDiscovered: Exit.Exit<string, GhAppError> =
                yield* Effect.exit(discoverAndCache(jwt));
              const freshId = Exit.getSuccess(reDiscovered);
              if (Option.isNone(freshId)) {
                // Re-discovery failed: propagate the ORIGINAL stale error —
                // the 401/404 is the actionable cause, not the discovery noise.
                return yield* Effect.fail(stale);
              }
              return yield* requestInstallationToken(
                config.fetchImpl,
                jwt,
                freshId.value
              );
            })
        )
      );
    });

  return { mint };
};

/** Layer providing `GhApp`, built on top of `GhAppConfig`. */
export const GhAppLive: Layer.Layer<GhApp, never, GhAppConfig> = Layer.effect(
  GhApp,
  GhAppConfig.pipe(Effect.map((config) => makeGhApp(config)))
);

/** Full default layer: `GhApp` provided from env-read `GhAppConfig`. */
export const GhAppDefault: Layer.Layer<GhApp, GhAppError> = GhAppLive.pipe(
  Layer.provide(GhAppConfigLive)
);

// #endregion
