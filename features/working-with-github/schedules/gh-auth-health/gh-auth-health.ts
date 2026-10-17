/**
 * gh-auth-health.ts — the mint + round-trip check behind the gh-auth-health
 * schedule, plus the alert rendering.
 *
 * Deliberately free of any `ori` / Slack-client imports so the check and the
 * message rendering are unit-testable in isolation with injected fakes.
 * `schedule.ts` wires these to the real token mint and the shared Slack poster.
 *
 * What "healthy" means: the GitHub App can mint an installation token AND that
 * token can actually reach the repo (a `GET /repos/{repo}` round-trip). Minting
 * alone is not enough — a token with no/with-revoked repo access would mint fine
 * but fail every real `git`/`gh` call, which is exactly the breakage this guards.
 */

import { Data, Effect, Option, Schema } from "effect";

import type {
  GhAppError,
  InstallationToken,
} from "@ori-monorepo/working-with-github/gh-app-token.ts";

/** The outcome of a completed health check — which access mode was proven and,
 *  in ambient mode, whether the host's GitHub access is reachable at all. */
export type HealthMode = "app-token" | "ambient";

/** What "healthy" means in ambient mode: a bare `GET /` on the API resolves.
 *  The workspace credential — when the host's proxy attaches one — rides the
 *  request automatically; there is no token to inspect, so the check proves
 *  reachability, not identity. `limited` carries GitHub's `x-oauth-scopes`
 *  hint when the response provides one. */
export interface AmbientProbeOk {
  readonly mode: "ambient";
  /** `x-oauth-scopes` from the response headers, when present. */
  readonly scopes: string | undefined;
}

/** Ambient-mode failure: GitHub is unreachable or answers with a server error.
 *  A 401/403/404 on `GET /` is reported as healthy-but-unauthenticated, not as
 *  a breakage — on a host with no proxy credential those are the honest
 *  answer, and the schedule has nothing to alert about. */
export class AmbientProbeError extends Data.TaggedError("AmbientProbeError")<{
  readonly detail: string;
}> {}

/**
 * Bare `GET https://api.github.com/` — the ambient-mode probe. Sends no
 * Authorization header: on hosts that attach a workspace credential through an
 * egress proxy it still reaches GitHub (and echoes the effective scopes); on
 * hosts without one it lands on the anonymous rate limit, which is healthy.
 */
export const ambientGitHubReachable = (input: {
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<AmbientProbeOk, AmbientProbeError> => {
  const fetchImpl = input.fetchImpl ?? fetch;
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl("https://api.github.com/", {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }),
      catch: (error) =>
        new AmbientProbeError({
          detail: error instanceof Error ? error.message : String(error),
        }),
    });
    if (response.status >= 500) {
      return yield* new AmbientProbeError({
        detail: `GET / answered HTTP ${String(response.status)}`,
      });
    }
    const scopes =
      typeof response.headers.get("x-oauth-scopes") === "string" &&
      response.headers.get("x-oauth-scopes") !== ""
        ? (response.headers.get("x-oauth-scopes") ?? undefined)
        : undefined;
    return { mode: "ambient", scopes } satisfies AmbientProbeOk;
  });
};

/** The subset of `fetch` this module uses — narrow so tests can inject a fake
 *  without satisfying Bun's full `typeof fetch` (which requires `preconnect`).
 *  `fetch` is a platform API; we wrap it with `Effect.tryPromise` at the seam. */
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HealthCheckInput {
  readonly fetchImpl?: FetchLike;
  /** Mint a fresh installation token — an Effect, injected so the check is
   *  testable with a fake that succeeds or fails in the GhAppError channel. */
  readonly mint: Effect.Effect<InstallationToken, GhAppError>;
  /** `owner/repo` to round-trip against (the intern's own repo). */
  readonly repo: string;
}

/** The success value: a healthy check. No `ok` discriminant — success lives in
 *  the Effect's success channel. */
export interface HealthCheckOk {
  readonly repoFullName: string;
  readonly tokenExpiresAt: string;
}

/**
 * The failure value: which stage broke + a human detail. A tagged error living
 * in the Effect's failure channel — the Effect-native replacement for the old
 * `{ ok: false }` result shape.
 */
export class HealthCheckError extends Data.TaggedError("HealthCheckError")<{
  readonly stage: "mint" | "round-trip";
  readonly detail: string;
}> {}

/**
 * GitHub's error envelope. `message` is `optional` so a body that lacks it (or
 * is not an object at all) degrades to the HTTP status rather than failing:
 * the round-trip has already failed, and a schema complaint here would bury
 * GitHub's own explanation of why.
 */
const GitHubErrorBody = Schema.Struct({
  message: Schema.optional(Schema.String),
});

/**
 * `GET /repos/{repo}`, narrowed to the one field the check reads. An empty
 * `full_name` is rejected at decode: the whole point of the round-trip is that
 * the token names the repo back, and `""` names nothing.
 */
const RepoResponse = Schema.Struct({
  full_name: Schema.NonEmptyString,
});

/** GitHub's non-2xx `message`, falling back to the status when the body is not the envelope. */
const githubErrorDetail = (payload: unknown, status: number): string => {
  const decoded = Schema.decodeUnknownOption(GitHubErrorBody)(payload);
  const message = Option.isSome(decoded) ? decoded.value.message : undefined;
  return message ?? `HTTP ${status}`;
};

/**
 * `GET /repos/{repo}` with the minted token; succeeds with the repo full_name,
 * or fails with a `round-trip` `HealthCheckError` (network error, non-JSON body,
 * or non-ok HTTP).
 */
const verifyRepoAccess = (input: {
  readonly fetchImpl: FetchLike;
  readonly repo: string;
  readonly token: string;
}): Effect.Effect<string, HealthCheckError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        input.fetchImpl(`https://api.github.com/repos/${input.repo}`, {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${input.token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }),
      catch: (error) =>
        new HealthCheckError({
          stage: "round-trip",
          detail: error instanceof Error ? error.message : String(error),
        }),
    });

    const payload = yield* Effect.tryPromise({
      try: (): Promise<unknown> => response.json(),
      catch: (error) =>
        new HealthCheckError({
          stage: "round-trip",
          detail: `repo response was not JSON: ${String(error)}`,
        }),
    });

    if (!response.ok) {
      return yield* new HealthCheckError({
        stage: "round-trip",
        detail: githubErrorDetail(payload, response.status),
      });
    }

    const body = yield* Schema.decodeUnknownEffect(RepoResponse, {
      errors: "all",
    })(payload).pipe(
      Effect.mapError(
        (error) =>
          new HealthCheckError({
            stage: "round-trip",
            detail: `repo response did not match the expected shape: ${error.message}`,
          })
      )
    );
    return body.full_name;
  });

/**
 * The two-stage check as a single Effect: mint, then verify the token reaches
 * `repo`. Succeeds with a `HealthCheckOk`; a failure at either stage is a
 * `HealthCheckError` in the failure channel (tagged with which stage broke). No
 * Promises and no `Result` — the schedule branches on the two channels via
 * `Effect.matchEffect` at the ori boundary.
 */
export const ghAuthHealthCheck = (
  input: HealthCheckInput
): Effect.Effect<HealthCheckOk, HealthCheckError> => {
  const fetchImpl = input.fetchImpl ?? fetch;
  return Effect.gen(function* () {
    const token = yield* input.mint.pipe(
      Effect.mapError(
        (error) =>
          new HealthCheckError({
            stage: "mint",
            detail: error.message,
          })
      )
    );
    const repoFullName = yield* verifyRepoAccess({
      fetchImpl,
      repo: input.repo,
      token: token.token,
    });
    return {
      repoFullName,
      tokenExpiresAt: token.expiresAt,
    } satisfies HealthCheckOk;
  });
};

/** Render the Slack alert text for a failed health check. */
export const renderHealthAlert = (
  repo: string,
  failure: HealthCheckError
): string => {
  const stageLabel =
    failure.stage === "mint" ? "token mint" : "repo round-trip";
  return [
    `:rotating_light: *GitHub auth health check failed* — \`${repo}\``,
    `Stage: *${stageLabel}*`,
    `Detail: ${failure.detail}`,
    "",
    "Mint-on-demand GitHub auth is not working — `git`/`gh` operations will fail until this is fixed. Check `GH_APP_ID`, `GH_APP_PRIVATE_KEY`, and `GITHUB_REPO` (its org is used to discover the App installation) in the service env, and the App's installation/repo access.",
  ].join("\n");
};

/** One-line, log-friendly success summary (no token material). */
export const formatHealthOkLog = (repo: string, ok: HealthCheckOk): string =>
  `gh-auth-health: ok — minted token reaches ${ok.repoFullName} (expires ${ok.tokenExpiresAt}) for ${repo}.`;

/** One-line, log-friendly failure summary (no token material). */
export const formatHealthErrorLog = (
  repo: string,
  failure: HealthCheckError
): string =>
  `gh-auth-health: FAILED at ${failure.stage} for ${repo} — ${failure.detail}`;
