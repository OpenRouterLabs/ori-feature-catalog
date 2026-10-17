// gh-app-registry.ts — a dedicated bun:sqlite store mapping (org, purpose) to the
// NAMES of the env vars that hold a GitHub App's credentials. It never stores a
// secret value — only which env keys to read at mint time (`gh-app-token.ts`
// resolves the values from `process.env`).
//
// One table in the intern's dedicated gh-app-registry.db (path derived from the
// intern name — see resolveConfigDirName):
//   - `gh_app_registry` — (org, purpose) → {app_id_key, private_key_key}
//
// The default app (bare `GH_APP_ID` / `GH_APP_PRIVATE_KEY`) needs no row; it is
// the final fallback in `resolveApp`.

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DB_DIR_MODE = 0o700;
const DB_FILE_MODE = 0o600;
/** `Date.now()` is milliseconds; `registered_at` is stored in whole seconds. */
const MS_PER_SECOND = 1000;

/** The purpose used for an org's catch-all row and the default when none is given. */
export const DEFAULT_PURPOSE = "default";

// #region Config dir resolution

/** Reduce an arbitrary string to a safe single path segment. */
const sanitizeSegment = (raw: string): string =>
  raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/gu, "-")
    .replaceAll(/^[.-]+|[.-]+$/gu, "");

/**
 * Resolve the intern's config directory name — `INTERN_NAME`, else the repo
 * segment of `GITHUB_REPO`, else `"intern"`. Mirrors the linear feature's
 * resolver so both stores land under the same `~/.config/<name>/` directory.
 */
export const resolveConfigDirName = (
  env: Readonly<Record<string, string | undefined>> = Bun.env
): string => {
  const fromInternName = (env.INTERN_NAME ?? "").trim();
  if (fromInternName !== "") {
    return sanitizeSegment(fromInternName);
  }
  const repoRaw = (env.GITHUB_REPO ?? "").trim().replace(/\.git$/u, "");
  if (repoRaw !== "") {
    const match = /(?:github\.com[/:])?([^/]+)\/([^/]+)$/u.exec(repoRaw);
    const repoName = match?.[2] ?? repoRaw;
    const sanitized = sanitizeSegment(repoName);
    if (sanitized !== "") {
      return sanitized;
    }
  }
  return "intern";
};

// #endregion

// #region Types

/** The env-var key names for one registered app — values are never stored. */
export interface GhAppKeyNames {
  readonly appIdKey: string;
  readonly privateKeyKey: string;
}

export interface RegisterAppInput extends GhAppKeyNames {
  readonly org: string;
  readonly purpose: string;
}

interface RawRow {
  readonly org: string;
  readonly purpose: string;
  readonly app_id_key: string;
  readonly private_key_key: string;
  readonly registered_at: number;
}

export interface GhAppRegistryRow extends GhAppKeyNames {
  readonly org: string;
  readonly purpose: string;
  readonly registeredAt: number;
}

// #endregion

// #region Schema + opener

export const createGhAppRegistrySchema = (db: Database): void => {
  // `org` and `purpose` are COLLATE NOCASE: GitHub org logins are effectively
  // case-insensitive, so registering `acme-corp` must match a mint against
  // `acme-corp/...` rather than silently missing the row and falling back
  // to the default app. NOCASE applies to the PRIMARY KEY uniqueness and to
  // every `WHERE org = ? AND purpose = ?` equality lookup.
  db.run(`
    CREATE TABLE IF NOT EXISTS gh_app_registry (
      org             TEXT    NOT NULL COLLATE NOCASE,
      purpose         TEXT    NOT NULL COLLATE NOCASE,
      app_id_key      TEXT    NOT NULL,
      private_key_key TEXT    NOT NULL,
      registered_at   INTEGER NOT NULL,
      PRIMARY KEY (org, purpose)
    )
  `);
  // Cache of discovered installation ids so a mint skips the `GET /app/installations`
  // pagination on the hot path. Keyed by (app_id, org) — `org` is COLLATE NOCASE
  // to match discovery's case-insensitive login matching. An installation id is a
  // GitHub-stable identifier, so there is no TTL: a stale entry (App reinstalled)
  // is detected by a 401/404 on the token POST and invalidated then. `app_id` is
  // the numeric App id (not a secret); `installation_id` is likewise not a secret.
  db.run(`
    CREATE TABLE IF NOT EXISTS gh_installation_cache (
      app_id          TEXT    NOT NULL,
      org             TEXT    NOT NULL COLLATE NOCASE,
      installation_id TEXT    NOT NULL,
      cached_at       INTEGER NOT NULL,
      PRIMARY KEY (app_id, org)
    )
  `);
};

/**
 * Open the intern's dedicated GitHub-App registry DB and ensure the schema
 * exists. Pass `":memory:"` in tests. Mirrors the linear feature's opener
 * (0o700 dir / 0o600 file / WAL) so the store lands beside the others under
 * `~/.config/<resolveConfigDirName()>/`.
 */
export const openGhAppRegistryDb = (path?: string): Database => {
  if (path !== undefined) {
    const memDb = new Database(path);
    memDb.run("PRAGMA journal_mode = WAL;");
    createGhAppRegistrySchema(memDb);
    return memDb;
  }
  const dir = join(homedir(), ".config", resolveConfigDirName());
  mkdirSync(dir, {
    mode: DB_DIR_MODE,
    recursive: true,
  });
  const dbPath = join(dir, "gh-app-registry.db");
  const db = new Database(dbPath);
  try {
    // Non-fatal — some filesystems (e.g. Docker volumes) ignore chmod.
    chmodSync(dbPath, DB_FILE_MODE);
  } catch {
    // ignore
  }
  db.run("PRAGMA journal_mode = WAL;");
  createGhAppRegistrySchema(db);
  return db;
};

// #endregion

// #region CRUD + resolution

const rowToKeyNames = (row: RawRow): GhAppKeyNames => ({
  appIdKey: row.app_id_key,
  privateKeyKey: row.private_key_key,
});

/** Upsert the (org, purpose) → key-names mapping. */
export const registerApp = (db: Database, input: RegisterAppInput): void => {
  db.run(
    `INSERT OR REPLACE INTO gh_app_registry
       (org, purpose, app_id_key, private_key_key, registered_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      input.org,
      input.purpose,
      input.appIdKey,
      input.privateKeyKey,
      Math.floor(Date.now() / MS_PER_SECOND),
    ]
  );
};

/** Look up the exact (org, purpose) row, or null when absent. */
export const lookupApp = (
  db: Database,
  org: string,
  purpose: string
): GhAppKeyNames | null => {
  const row = db
    .query<RawRow, [string, string]>(
      "SELECT * FROM gh_app_registry WHERE org = ? AND purpose = ?"
    )
    .get(org, purpose);
  return row ? rowToKeyNames(row) : null;
};

/**
 * Resolve the key names for (org, purpose) via the fallback chain:
 *   (org, purpose) → (org, DEFAULT_PURPOSE) → null.
 * A null result means the caller should fall back to the bare default app
 * (`GH_APP_ID` / `GH_APP_PRIVATE_KEY`) — that final step lives in gh-app-token.
 */
export const resolveApp = (
  db: Database,
  org: string,
  purpose: string
): GhAppKeyNames | null => {
  const exact = lookupApp(db, org, purpose);
  if (exact !== null) {
    return exact;
  }
  if (purpose !== DEFAULT_PURPOSE) {
    return lookupApp(db, org, DEFAULT_PURPOSE);
  }
  return null;
};

/** List every registered row (org + purpose + key names — never values). */
export const listApps = (db: Database): GhAppRegistryRow[] => {
  const rows = db
    .query<RawRow, []>("SELECT * FROM gh_app_registry ORDER BY org, purpose")
    .all();
  return rows.map((row) => ({
    appIdKey: row.app_id_key,
    org: row.org,
    privateKeyKey: row.private_key_key,
    purpose: row.purpose,
    registeredAt: row.registered_at,
  }));
};

// #endregion

// #region Installation-id cache

interface CacheRow {
  readonly app_id: string;
  readonly org: string;
  readonly installation_id: string;
  readonly cached_at: number;
}

/**
 * The cache key: the numeric App id plus the target org. An empty `org` (the
 * default app with no derivable org) is stored under the literal empty string,
 * so the "App's sole installation" result is cached too.
 */
export interface InstallationCacheKey {
  readonly appId: string;
  readonly org: string;
}

/** Look up a cached installation id for (appId, org), or null when absent. */
export const getCachedInstallation = (
  db: Database,
  key: InstallationCacheKey
): string | null => {
  const row = db
    .query<CacheRow, [string, string]>(
      "SELECT * FROM gh_installation_cache WHERE app_id = ? AND org = ?"
    )
    .get(key.appId, key.org);
  return row ? row.installation_id : null;
};

/** Upsert the cached installation id for (appId, org). */
export const putCachedInstallation = (
  db: Database,
  key: InstallationCacheKey,
  installationId: string
): void => {
  db.run(
    `INSERT OR REPLACE INTO gh_installation_cache (app_id, org, installation_id, cached_at)
     VALUES (?, ?, ?, ?)`,
    [key.appId, key.org, installationId, Math.floor(Date.now() / MS_PER_SECOND)]
  );
};

/** Drop the cached installation id for (appId, org) — called when it proves stale. */
export const deleteCachedInstallation = (
  db: Database,
  key: InstallationCacheKey
): void => {
  db.run("DELETE FROM gh_installation_cache WHERE app_id = ? AND org = ?", [
    key.appId,
    key.org,
  ]);
};

/**
 * Drop every cached row whose `org` is not in `allowedOrgs` (compared
 * case-insensitively). Poisoned rows from the public-App incident — an
 * installation discovered against a foreign org before the fail-closed
 * allowlist landed — are purged here so they can never be served again. The
 * empty-org (`""`) sole-installation row is also dropped: its key carries no
 * owner identity, so it can never be trusted (the mint flow no longer reads or
 * writes it). Returns the number of rows deleted.
 */
export const purgeNonAllowlistedInstallations = (
  db: Database,
  allowedOrgs: Iterable<string>
): number => {
  const allowed = Array.from(allowedOrgs)
    .map((login) => login.trim().toLowerCase())
    .filter((login) => login !== "");
  // Keep only rows whose org is allowlisted; the empty-org row is untrusted by
  // construction (no owner identity in the key), so it is deleted as well.
  const placeholders = allowed.map(() => "?").join(", ");
  const sql =
    allowed.length > 0
      ? `DELETE FROM gh_installation_cache WHERE org = '' OR lower(org) NOT IN (${placeholders})`
      : "DELETE FROM gh_installation_cache";
  const result = db.run(sql, allowed);
  return result.changes;
};

/**
 * A persistent installation-id cache seam, keyed by (appId, org). The mint flow
 * consults it to skip the `GET /app/installations` round-trip. Injected so tests
 * use an in-memory fake; {@link sqliteInstallationCache} is the production impl.
 */
export interface InstallationCache {
  readonly get: (appId: string, org: string) => string | null;
  readonly put: (appId: string, org: string, installationId: string) => void;
  readonly delete: (appId: string, org: string) => void;
  /**
   * Drop every cached row whose org is not in `allowedOrgs`, plus any empty-org
   * row (fail-closed cleanup of poisoned rows from the public-App incident).
   * Returns the rows removed.
   */
  readonly purge: (allowedOrgs: Iterable<string>) => number;
}

/** Open the registry, run `fn`, always close; return `fallback` on any failure. */
const withDb = <T>(fn: (db: Database) => T, fallback: T): T => {
  try {
    const db = openGhAppRegistryDb();
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } catch {
    return fallback;
  }
};

/**
 * Production installation cache: each operation opens the SQLite registry, does
 * its work, and closes — best-effort, so any failure (DB unavailable, etc.)
 * degrades to a no-op (get → miss → discovery still runs). A short-lived
 * connection per call is fine: a mint does at most one get + one put, dwarfed by
 * the network round-trips it saves. `mint-token.ts` runs as a fresh process per
 * invocation, so only this persistent cache (not an in-memory one) ever hits.
 */
export const sqliteInstallationCache: InstallationCache = {
  delete: (appId, org) => {
    withDb((db) => {
      deleteCachedInstallation(db, {
        appId,
        org,
      });
      return null;
    }, null);
  },
  get: (appId, org) =>
    withDb(
      (db) =>
        getCachedInstallation(db, {
          appId,
          org,
        }),
      null
    ),
  purge: (allowedOrgs) =>
    withDb((db) => purgeNonAllowlistedInstallations(db, allowedOrgs), 0),
  put: (appId, org, installationId) => {
    withDb((db) => {
      putCachedInstallation(
        db,
        {
          appId,
          org,
        },
        installationId
      );
      return null;
    }, null);
  },
};

// #endregion

/** Extract the org from an `owner/repo` (or full GitHub URL) string. */
export const orgOf = (repo: string): string => {
  const cleaned = repo.trim().replace(/\.git$/u, "");
  const match = /(?:github\.com[/:])?([^/]+)\/[^/]+$/u.exec(cleaned);
  return match?.[1] ?? cleaned;
};
