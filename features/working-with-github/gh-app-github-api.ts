/**
 * gh-app-github-api.ts — the low-level GitHub App plumbing behind
 * `gh-app-token.ts`: the typed failure, the shared value types, RS256 JWT
 * signing, access-token response parsing, and installation discovery.
 *
 * Kept separate from the Effect service/layer composition so each file stays
 * small and the GitHub-contract details live in one place. Nothing here persists
 * a token or touches disk; every function is a pure transform or an Effect over
 * an injected `fetch`.
 *
 * GitHub App JWT flow:
 * https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 */

import { createSign } from "node:crypto";

import { Data, Effect, Option, Schema } from "effect";

// #region Error

/** Single typed failure for every GitHub App auth operation. */
export class GhAppError extends Data.TaggedError("GhAppError")<{
  /** The failing operation — "config" | "sign" | "request" | "parse" | "http" | "discover". */
  readonly op: string;
  /** Human-readable failure message (safe to surface — never carries a secret). */
  readonly message: string;
  /** HTTP status for "http"/"discover" failures; absent otherwise. */
  readonly status?: number;
  /** Underlying thrown value, when there is one. */
  readonly cause?: unknown;
}> {}

// #endregion

// #region Types

export interface GhAppCredentials {
  readonly appId: string;
  /** Base64-encoded PEM private key, as stored in the service env. */
  readonly privateKeyBase64: string;
  /**
   * Target org for installation discovery (`GET /app/installations` matching
   * `account.login`). Empty/undefined → the App's sole installation is used.
   */
  readonly org?: string;
}

/**
 * A live installation token plus the moment GitHub says it expires. Callers
 * that cache (none today) could honour `expiresAt`; the wrappers ignore it and
 * mint fresh every invocation.
 */
export interface InstallationToken {
  readonly expiresAt: string;
  readonly token: string;
}

/** The subset of `fetch` this module uses — narrow so tests can inject a fake
 *  without satisfying Bun's full `typeof fetch` (which requires `preconnect`). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// #endregion

// #region Installation-owner allowlist

/** Env var naming the installation-owner logins a token may be minted against (comma/space-separated). */
const ALLOWED_ORGS_ENV = "GH_APP_ALLOWED_ORGS";

/**
 * Resolve the allowlist of permitted installation-owner logins, lower-cased for
 * comparison. Precedence: explicit `override` (an array, from a caller) → the
 * `GH_APP_ALLOWED_ORGS` env var (comma/space/newline-separated) → the owner of
 * `GITHUB_REPO`. A GitHub App can be installed by anyone once it is public, so
 * discovery FAILS CLOSED: an empty result allows no installation at all.
 */
export const resolveAllowedOrgs = (
  override?: readonly string[],
  env?: Readonly<Record<string, string | undefined>>
): Set<string> => {
  // An empty/whitespace-only var is treated as UNSET, not as an explicit
  // allow-none: a cleared `Environment=GH_APP_ALLOWED_ORGS=` (systemd reset),
  // a compose interpolation of an unset variable, or a blank env-file line
  // must fall back to the documented default (the `GITHUB_REPO` owner), not
  // fail every mint closed. A set var with real logins still wins.
  const rawAllow = override === undefined ? env?.[ALLOWED_ORGS_ENV] : undefined;
  const fromEnv =
    rawAllow !== undefined && rawAllow.trim() !== ""
      ? rawAllow.split(/[\s,]+/u)
      : undefined;
  // Tolerate the same `GITHUB_REPO` spellings the sibling resolvers do (a full
  // https URL with optional .git suffix, or a bare owner/repo) — `split("/")[0]`
  // would reduce a URL to "https:" and fail every mint closed.
  // Trim trailing slashes as well as whitespace (a copy-pasted
  // `https://github.com/acme/widgets.git/`): the repoMatch alternative
  // below fails on the trailing slash, and the repoOwner fallback then
  // reduces the URL to its scheme (`https:`) — a login no installation
  // can ever carry, so every mint fails closed with no hint why.
  const rawRepo = (env?.GITHUB_REPO ?? "")
    .trim()
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "");
  // A deep GitHub URL — `https://github.com/o/r/tree/main` (a copied
  // blob/tree/PR/releases address) — resolves to its owner too: the
  // two-segment-only match missed it, and the `split("/")[0]` fallback then
  // reduced the URL to its SCHEME (`https:`), a login no installation can
  // ever carry — so every mint failed closed with no hint why.
  const repoMatch = /github\.com[/:]([^/]+)\/[^/]+(?:\/.*)?$/u.exec(rawRepo);
  const repoOwner = repoMatch?.[1] ?? rawRepo.split("/")[0];
  const fromRepo = repoOwner === undefined ? [] : [repoOwner];
  const source = override ?? fromEnv ?? fromRepo;
  return new Set(
    source
      .map((login) => login.trim().toLowerCase())
      .filter((login) => login !== "")
  );
};

/** True when `login` is in `allowed` (both compared lower-cased). */
export const isAllowlistedOrg = (
  login: string,
  allowed: Set<string>
): boolean => allowed.has(login.trim().toLowerCase());

/** Terminal `op:"discover"` failure for a non-allowlisted installation owner. */
const rejectForeignInstallation = (
  login: string,
  allowed: Set<string>
): GhAppError =>
  new GhAppError({
    message: `Refusing to mint a token for GitHub App installation owned by "${login}": not in the allowed-orgs allowlist (${Array.from(allowed).join(", ")}). Set ${ALLOWED_ORGS_ENV} to override.`,
    op: "discover",
  });

/** Standard headers for the GitHub App REST endpoints, given a bearer JWT. */
const githubAppHeaders = (jwt: string): Record<string, string> => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${jwt}`,
  "X-GitHub-Api-Version": "2022-11-28",
});

// #endregion

// #region JWT signing

const SECONDS_PER_MINUTE = 60;
/** GitHub caps App JWTs at 10 minutes; leave 1 minute of clock-skew room. */
const JWT_LIFETIME_MINUTES = 9;
/** JWT lifetime in seconds: GitHub caps App JWTs at 10 minutes; 9 leaves skew room. */
const JWT_LIFETIME_SECONDS = JWT_LIFETIME_MINUTES * SECONDS_PER_MINUTE;
/** Backdate `iat` to tolerate minor clock skew against GitHub, per their docs. */
const JWT_BACKDATE_SECONDS = SECONDS_PER_MINUTE;

const base64Url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64url");

/** Sign a GitHub App JWT (RS256), as an Effect; terminal `sign` GhAppError on failure. */
export const signAppJwt = (
  credentials: GhAppCredentials,
  nowSeconds: number
): Effect.Effect<string, GhAppError> =>
  Effect.suspend(() => {
    // GitHub's JWT `iss` must be the numeric App id. `Number("abc")` is NaN,
    // which `JSON.stringify` serializes as `null` — a silent bad JWT that fails
    // opaquely at GitHub. Fail loudly here with the App id NAME, never a secret.
    const appIdNumber = Number(credentials.appId);
    if (!Number.isInteger(appIdNumber) || appIdNumber <= 0) {
      return Effect.fail(
        new GhAppError({
          message: `GitHub App id must be a positive integer, got "${credentials.appId}" — check GH_APP_ID (or the registered app-id env var).`,
          op: "config",
        })
      );
    }
    const pem = Buffer.from(credentials.privateKeyBase64, "base64").toString(
      "utf-8"
    );
    const header = base64Url(
      JSON.stringify({
        alg: "RS256",
        typ: "JWT",
      })
    );
    const payload = base64Url(
      JSON.stringify({
        exp: nowSeconds + JWT_LIFETIME_SECONDS,
        iat: nowSeconds - JWT_BACKDATE_SECONDS,
        iss: appIdNumber,
      })
    );
    const signingInput = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    return Effect.try({
      catch: (cause) =>
        new GhAppError({
          cause,
          message: `Failed to sign GitHub App JWT: ${cause instanceof Error ? cause.message : String(cause)}`,
          op: "sign",
        }),
      try: () => `${signingInput}.${signer.sign(pem, "base64url")}`,
    });
  });

// #endregion

// #region Response schemas

/**
 * GitHub's error envelope, returned on every non-2xx REST response. `message`
 * is `optional` rather than required because a body that lacks it (or is not an
 * object at all) still has to degrade to the HTTP status, not to a failure.
 */
const GitHubErrorBody = Schema.Struct({
  message: Schema.optional(Schema.String),
});

/**
 * GitHub's non-2xx `message`, falling back to the status when the body is not
 * the error envelope. Decoding is deliberately tolerant here: the request has
 * already failed, and a second failure would replace GitHub's own explanation
 * with a schema complaint.
 */
const githubErrorDetail = (payload: unknown, status: number): string => {
  const decoded = Schema.decodeUnknownOption(GitHubErrorBody)(payload);
  const message = Option.isSome(decoded) ? decoded.value.message : undefined;
  return message ?? `HTTP ${status}`;
};

/**
 * Read a response body as JSON, degrading to `null` when the body is not JSON
 * at all (an HTML error page, a 0-byte body). Used before the `response.ok`
 * branch: a non-2xx must be explained by its own envelope (or degrade to the
 * status), never fail `op:"parse"` — which would both mislabel the failure
 * and hide the 401/404 status `gh-app-token.ts` matches a stale-installation
 * retry on.
 */
const readBodyJson = (response: Response): Promise<unknown> =>
  response.json().catch(() => null);

/**
 * `POST /app/installations/{id}/access_tokens`. Only the two fields the caller
 * reads are declared; `permissions` and `repository_selection` are ignored, as
 * anything GitHub adds later will be. An empty `token` is rejected at decode:
 * it can never authenticate a request, so it is malformed rather than absent.
 */
const AccessTokenResponse = Schema.Struct({
  expires_at: Schema.String,
  token: Schema.NonEmptyString,
});

/**
 * One entry of `GET /app/installations`. `account` is nullable in GitHub's own
 * schema (an enterprise installation has none), so a null account is a shape
 * this endpoint really produces, not a malformed one — the projection below
 * skips those entries because they carry no login to match an org against.
 */
const Installation = Schema.Struct({
  account: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  id: Schema.Union([Schema.Number, Schema.String]),
});

const InstallationsPage = Schema.Array(Installation);

/** Decode options shared by every boundary here: report every bad field, not just the first. */
const ALL_ERRORS = { errors: "all" } as const;

// #endregion

// #region Installation discovery

const INSTALLATIONS_PAGE_SIZE = 100;

/** The (installationId, accountLogin) pairs discovery matches on. */
interface InstallationRef {
  readonly id: string;
  readonly login: string;
}

/** Project a decoded installations page into the pairs discovery matches on,
 *  dropping the account-less entries GitHub's schema allows. */
const projectInstallations = (
  page: ReadonlyArray<(typeof Installation)["Type"]>
): InstallationRef[] =>
  page.flatMap((entry) =>
    entry.account === null
      ? []
      : [
          {
            id: String(entry.id),
            login: entry.account.login,
          },
        ]
  );

/** Fetch one page of `GET /app/installations`, or fail `op:discover`/`op:parse`. */
const fetchInstallationsPage = (
  fetchImpl: FetchLike,
  jwt: string,
  page: number
): Effect.Effect<InstallationRef[], GhAppError> =>
  Effect.gen(function* () {
    const url = `https://api.github.com/app/installations?per_page=${INSTALLATIONS_PAGE_SIZE}&page=${page}`;
    const response = yield* Effect.tryPromise({
      catch: (cause) =>
        new GhAppError({
          cause,
          message: `GitHub installations list failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          op: "discover",
        }),
      try: () =>
        fetchImpl(url, {
          headers: githubAppHeaders(jwt),
          method: "GET",
        }),
    });
    if (!response.ok) {
      return yield* new GhAppError({
        message: `GitHub installations list failed: HTTP ${response.status}`,
        op: "discover",
        status: response.status,
      });
    }
    const payload = yield* Effect.tryPromise({
      catch: (cause) =>
        new GhAppError({
          cause,
          message: `GitHub installations response was not JSON: ${String(cause)}`,
          op: "parse",
        }),
      try: (): Promise<unknown> => response.json(),
    });
    const decoded = yield* Schema.decodeUnknownEffect(
      InstallationsPage,
      ALL_ERRORS
    )(payload).pipe(
      Effect.mapError(
        (error) =>
          new GhAppError({
            cause: error,
            message: `GitHub installations response did not match the expected shape: ${error.message}`,
            op: "parse",
          })
      )
    );
    return projectInstallations(decoded);
  });

/**
 * Discover the installation id for an App by paginating `GET /app/installations`.
 *
 * - With a non-empty `org`, matches `account.login` (case-insensitive) — used
 *   for registry-resolved apps AND the default app when `GITHUB_REPO` yields an
 *   org.
 * - With an empty `org` (org couldn't be derived), falls back to the App's sole
 *   installation; if the App has zero or several installations that's ambiguous
 *   and fails, so the caller sets `GITHUB_REPO`/targets a repo.
 *
 * FAIL CLOSED: the chosen installation's owner login MUST be in `allowedOrgs`
 * (`GH_APP_ALLOWED_ORGS`, else the owner of `GITHUB_REPO`).
 * A foreign owner is rejected on EVERY path — including the org-match and the
 * empty-org sole-installation fallback — so a token can never be minted against
 * an installation the operator did not allow.
 *
 * Fails with `op:"discover"` (list request failed, non-2xx, no/ambiguous match,
 * non-allowlisted owner) or `op:"parse"` (a page body was not JSON).
 */
export const discoverInstallationId = (
  fetchImpl: FetchLike,
  jwt: string,
  org: string,
  allowedOrgs?: Set<string>
): Effect.Effect<string, GhAppError> =>
  Effect.gen(function* () {
    const allowed = allowedOrgs ?? resolveAllowedOrgs(undefined, process.env);
    const wanted = org.trim().toLowerCase();
    const all: InstallationRef[] = [];
    for (let page = 1; ; page += 1) {
      const parsed = yield* fetchInstallationsPage(fetchImpl, jwt, page);
      if (wanted !== "") {
        const match = parsed.find(
          (inst) => inst.login.toLowerCase() === wanted
        );
        if (match !== undefined) {
          // A requested org still has to clear the allowlist — an attacker org
          // that got the App installed must never be resolvable, even by name.
          if (!isAllowlistedOrg(match.login, allowed)) {
            return yield* rejectForeignInstallation(match.login, allowed);
          }
          return match.id;
        }
      }
      all.push(...parsed);
      if (parsed.length < INSTALLATIONS_PAGE_SIZE) {
        break;
      }
    }

    // No org to match on: use the App's sole installation, else it's ambiguous.
    if (wanted === "") {
      if (all.length === 1 && all[0] !== undefined) {
        const sole = all[0];
        // Even a single installation must be allowlisted: a lone FOREIGN install
        // (the public-App attack) is rejected, not blindly trusted.
        if (!isAllowlistedOrg(sole.login, allowed)) {
          return yield* rejectForeignInstallation(sole.login, allowed);
        }
        return sole.id;
      }
      return yield* new GhAppError({
        message:
          all.length === 0
            ? "No GitHub App installation found. Install the App, or set GITHUB_REPO so its org can be matched."
            : `GitHub App has ${all.length} installations (${all.map((i) => i.login).join(", ")}); set GITHUB_REPO or target a repo so the right one can be chosen.`,
        op: "discover",
      });
    }
    return yield* new GhAppError({
      message: `No GitHub App installation found for org "${org}". Known: ${all.map((i) => i.login).join(", ") || "(none)"}`,
      op: "discover",
    });
  });

// #endregion

/** POST `/app/installations/{id}/access_tokens` and return the minted token. */
export const requestInstallationToken = (
  fetchImpl: FetchLike,
  jwt: string,
  installationId: string
): Effect.Effect<InstallationToken, GhAppError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      catch: (cause) =>
        new GhAppError({
          cause,
          message: `GitHub installation-token request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          op: "request",
        }),
      try: () =>
        fetchImpl(
          `https://api.github.com/app/installations/${installationId}/access_tokens`,
          {
            headers: githubAppHeaders(jwt),
            method: "POST",
          }
        ),
    });

    // A non-2xx stays `op:"http"` with its status: `gh-app-token.ts` retries a
    // stale installation on exactly that shape, and a decode failure must not
    // be mistaken for one.
    const payload = yield* Effect.promise(() => readBodyJson(response));
    if (!response.ok) {
      return yield* new GhAppError({
        message: `GitHub installation-token mint failed: ${githubErrorDetail(payload, response.status)}`,
        op: "http",
        status: response.status,
      });
    }

    if (payload === null) {
      return yield* new GhAppError({
        message: "GitHub access-token response was not JSON",
        op: "parse",
      });
    }

    const body = yield* Schema.decodeUnknownEffect(
      AccessTokenResponse,
      ALL_ERRORS
    )(payload).pipe(
      Effect.mapError(
        (error) =>
          new GhAppError({
            cause: error,
            message: `GitHub access-token response did not match the expected shape: ${error.message}`,
            op: "parse",
          })
      )
    );

    return {
      expiresAt: body.expires_at,
      token: body.token,
    };
  });
