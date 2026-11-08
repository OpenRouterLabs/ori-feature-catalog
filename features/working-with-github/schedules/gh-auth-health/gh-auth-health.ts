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

import type { GhAppError } from "../../gh-app-token.ts";
import type { GitHubToken } from "../../gh-app-token-mint.ts";

/** The outcome of a completed health check — which access mode was proven and,
 *  in ambient mode, whether the host's GitHub access is reachable at all. */
export type HealthMode = "app-token" | "ambient";

/** What "healthy" means in ambient mode: a bare `GET /repos/{repo}` (or `GET /`
 *  with no repo) on the API resolves.
 *  The workspace credential — when the host's proxy attaches one — rides the
 *  request automatically; there is no token to inspect, so the check proves
 *  reachability, not identity. `limited` carries GitHub's `x-oauth-scopes`
 *  hint when the response provides one. */
export interface AmbientProbeOk {
  readonly mode: "ambient";
  /** `x-oauth-scopes` from the response headers, when present. */
  readonly scopes: string | undefined;
}

/** Ambient-mode failure: GitHub is unreachable, answers with a server error,
 *  refuses the credential attached to the request (a 401), or refuses the
 *  request because the effective rate limit is exhausted. A 403/404 is
 *  healthy-but-unauthenticated (on a host with no proxy credential those are
 *  the honest answer) — EXCEPT the 403s that mean
 *  the workspace cannot work at all: `x-ratelimit-remaining: 0`, or a
 *  secondary rate limit. Those fail every real GitHub call the feature makes,
 *  so the schedule must surface them, not log ok. */
export class AmbientProbeError extends Data.TaggedError("AmbientProbeError")<{
  readonly detail: string;
  /** True when GitHub ANSWERED but refused for an exhausted rate limit: the
   *  network path works, so the alert must not send the operator to it. */
  readonly rateLimited?: boolean;
  /** True when the probe asked the unscoped root `GET /` (no GITHUB_REPO).
   *  A proxy that attaches its credential per owner sends none there, so a
   *  rate limit on the root does not show that owner-scoped calls fail. */
  readonly unscoped?: boolean;
  /** True when GitHub (or the host in front of it) answered 401: a credential
   *  was attached and refused. A request with no credential never gets a 401
   *  on the probe's routes, so this is broken ambient access, not health. */
  readonly refused?: boolean;
}> {}

/**
 * How long the ambient probe waits for `GET /` before failing. A health
 * check that can wait forever can never alert: a hung connection (a dropped
 * route, a wedged proxy) leaves the fire pending, the runtime skips every
 * later fire, and the schedule whose whole job is to surface broken GitHub
 * access stays silent — precisely in the state it exists to catch. The
 * deadline turns "no answer" into the same failure channel as a 5xx.
 */
const AMBIENT_PROBE_TIMEOUT_MS = 15_000;

/**
 * How long the App-mode round-trip may take before the check stops waiting.
 * The ambient probe has bounded its wait since it gained a deadline
 * (AMBIENT_PROBE_TIMEOUT_MS): a hung `GET /` there wedges the fire, the
 * runtime skips every later fire, and the schedule whose job is to ALERT on
 * broken GitHub access stays silent. The App-mode path mints and then calls
 * `GET /repos/{repo}` with NO bound of its own — the same wedge shape, in the
 * mode the schedule was originally built for: a dropped route or a wedged
 * proxy after the mint leaves the fetch pending forever, and the alert that
 * says "GitHub auth is broken" never fires precisely because GitHub is
 * broken. The deadline turns "no answer" into the same `round-trip`
 * HealthCheckError channel a 5xx already uses.
 */
const ROUND_TRIP_TIMEOUT_MS = 15_000;

/**
 * How long the round-trip's response BODY read may wait before the check stops
 * waiting. The fetch above is bounded by `ROUND_TRIP_TIMEOUT_MS`, but a server
 * that answers the headers and then stalls the body leaves `response.json()`
 * pending forever — the exact wedge `readBodyJson` in `gh-app-github-api.ts`
 * and `commit-api-core.ts` exist to close, and this module's own docblock for
 * the fetch deadline describes ("a hung connection ... leaves the fire
 * pending, the runtime skips every later fire, and the schedule whose whole job
 * is to ALERT on broken GitHub access stays silent — precisely in the state it
 * exists to catch"). Pre-fix BOTH body reads below (the non-2xx envelope read
 * and the 2xx payload read) were the only unbounded waits left on the path.
 * The bound fails into the same `round-trip` HealthCheckError channel a 5xx
 * already uses, naming the deadline and the repo.
 */
const ROUND_TRIP_BODY_TIMEOUT_MS = ROUND_TRIP_TIMEOUT_MS;

/**
 * True when a 403 is GitHub's secondary rate limit rather than an auth
 * answer: a `retry-after` header, or a body message naming the limit. The
 * body read is bounded like the fetch; an unreadable or stalled body reads
 * as no message.
 */
const isSecondaryRateLimit = (response: Response): Effect.Effect<boolean> =>
  response.headers.get("retry-after") !== null
    ? Effect.succeed(true)
    : Effect.promise(() => response.text().catch(() => "")).pipe(
        Effect.timeoutOption(AMBIENT_PROBE_TIMEOUT_MS),
        Effect.map((body) =>
          /secondary rate limit/iu.test(Option.getOrElse(body, () => ""))
        )
      );

/** GitHub's error `message` from a bounded body read, or "" when the body is
 *  unreadable, stalled, or not the envelope. Capped so a long refusal cannot
 *  flood the alert. */
const errorBodyMessage = (response: Response): Effect.Effect<string> =>
  Effect.promise(() => response.text().catch(() => "")).pipe(
    Effect.timeoutOption(AMBIENT_PROBE_TIMEOUT_MS),
    Effect.map((body) => {
      try {
        const parsed: unknown = JSON.parse(Option.getOrElse(body, () => ""));
        const message =
          typeof parsed === "object" && parsed !== null && "message" in parsed
            ? parsed.message
            : undefined;
        return typeof message === "string" ? message.trim().slice(0, 200) : "";
      } catch {
        return "";
      }
    })
  );

/**
 * The ambient-mode probe: `GET /repos/{repo}` for the intern's own repo, or
 * bare `GET https://api.github.com/` when there is no repo to ask about. Sends
 * no Authorization header: on hosts that attach a workspace credential through
 * an egress proxy it still reaches GitHub (and echoes the effective scopes); on
 * hosts without one it lands on the anonymous rate limit, which is healthy.
 *
 * The repo route comes first because such a proxy attaches the credential PER
 * OWNER: a route naming an owner it reaches goes out credentialed, while the
 * unscoped root names no owner and goes out anonymously, on the shared 60/h
 * bucket. Reproduced live: the root answered 403 `x-ratelimit-remaining: 0`
 * (limit 60) while `GET /repos/<owner>/<repo>` answered 200 on a 15000/h
 * credential — a root-only probe paged "every GitHub REST call fails" while
 * every call the intern makes worked.
 */
export const ambientGitHubReachable = (input: {
  readonly fetchImpl?: FetchLike;
  /** Bare `owner/repo` to probe; empty or omitted probes the root. */
  readonly repo?: string;
}): Effect.Effect<AmbientProbeOk, AmbientProbeError> => {
  const fetchImpl = input.fetchImpl ?? fetch;
  const repo = (input.repo ?? "").trim();
  const route = repo === "" ? "/" : `/repos/${repo}`;
  const scope = repo === "" ? { unscoped: true } : {};
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(`https://api.github.com${route}`, {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }),
      catch: (error) =>
        new AmbientProbeError({
          // Name the route like the timeout and 5xx details do: a bare
          // "fetch failed" told the alert reader nothing about what was asked.
          detail: `GET ${route} failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
    }).pipe(
      // Bound the wait: a fetch that never settles is unreachability, not
      // health — see AMBIENT_PROBE_TIMEOUT_MS.
      Effect.timeoutOrElse({
        duration: AMBIENT_PROBE_TIMEOUT_MS,
        orElse: () =>
          new AmbientProbeError({
            detail: `GET ${route} did not answer within ${AMBIENT_PROBE_TIMEOUT_MS / 1000}s`,
          }),
      })
    );
    if (response.status >= 500) {
      return yield* new AmbientProbeError({
        detail: `GET ${route} answered HTTP ${String(response.status)}`,
      });
    }
    // A 401 is a credential that was attached and refused: GitHub answers an
    // uncredentialed `GET /` with 200 and an uncredentialed repo route with
    // 200 or 404, never 401. Pre-fix it logged "ok" in exactly the state this
    // check exists to catch: the host's credential revoked or expired.
    if (response.status === 401) {
      const message = yield* errorBodyMessage(response);
      return yield* new AmbientProbeError({
        detail: `GET ${route} answered HTTP 401${message === "" ? "" : ` (${message})`} — the credential attached to the request was refused`,
        refused: true,
      });
    }
    // A 403 whose rate limit is exhausted (the anonymous 60/h shared bucket
    // or a credential-capped one) is a genuine "cannot work" state: every
    // REST read the ambient mode relies on fails while it lasts. Distinguish
    // it from the healthy-but-unauthenticated 401/403/404 by the header
    // GitHub sends on every rate-limited response. Pre-fix the probe logged
    // "ok — GitHub API reachable" in exactly this state (observed live on a
    // workspace whose anonymous core limit hit 0 remaining).
    if (
      response.status === 403 &&
      response.headers.get("x-ratelimit-remaining") === "0"
    ) {
      return yield* new AmbientProbeError({
        detail:
          repo === ""
            ? `GET ${route} answered HTTP 403 with the rate limit exhausted (x-ratelimit-remaining: 0) — the unscoped root shows only that requests without a credential fail until the limit resets`
            : `GET ${route} answered HTTP 403 with the rate limit exhausted (x-ratelimit-remaining: 0) — every GitHub REST call fails until the limit resets`,
        rateLimited: true,
        ...scope,
      });
    }
    // A 429 (secondary/abuse rate limit) blocks every REST call the same way
    // the exhausted primary limit does — and unlike the auth 401/403/404 it
    // is a "cannot work" state, not an identity answer.
    if (response.status === 429) {
      return yield* new AmbientProbeError({
        detail: `GET ${route} answered HTTP 429 (secondary rate limit) — GitHub is refusing requests from this workspace`,
        rateLimited: true,
        ...scope,
      });
    }
    // GitHub answers a secondary rate limit with a 403 as often as a 429,
    // with quota still remaining, so the header check above misses it.
    // Its marks are a `retry-after` header or a message naming the limit
    // (the header is not always sent). Pre-fix that 403 logged ok while
    // every call failed, though the same limit as a 429 alerted.
    if (response.status === 403 && (yield* isSecondaryRateLimit(response))) {
      return yield* new AmbientProbeError({
        detail: `GET ${route} answered HTTP 403 (secondary rate limit) — GitHub is refusing requests from this workspace`,
        rateLimited: true,
        ...scope,
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
  /** Obtain the token — an Effect, injected so the check is testable with a
   *  fake that succeeds or fails in the GhAppError channel. */
  readonly mint: Effect.Effect<GitHubToken, GhAppError>;
  /** `owner/repo` to round-trip against (the intern's own repo). */
  readonly repo: string;
}

/** The success value: a healthy check. No `ok` discriminant — success lives in
 *  the Effect's success channel. */
export interface HealthCheckOk {
  readonly repoFullName: string;
  /** Absent for the host-rotated `GH_TOKEN`, which carries no expiry. */
  readonly tokenExpiresAt?: string;
}

/**
 * The failure value: which stage broke + a human detail. A tagged error living
 * in the Effect's failure channel — the Effect-native replacement for the old
 * `{ ok: false }` result shape.
 */
export class HealthCheckError extends Data.TaggedError("HealthCheckError")<{
  readonly stage: "mint" | "round-trip";
  readonly detail: string;
  /** Why a round-trip failed when it was not the token: GitHub refused for a
   *  rate limit (the token works), or it never answered with a verdict (a
   *  network error, a timeout, a 5xx), so the token was never tested. Absent
   *  means the answer was about access, and the auth remedy applies. */
  readonly kind?: "rate-limited" | "unreachable";
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
 * Classify a non-2xx round-trip answer for the alert remedy. A rate limit
 * (429, or a 403 with the primary limit exhausted, a `retry-after`, or a
 * "rate limit" message) means GitHub accepted the token and refused the
 * request budget; a 5xx means GitHub or the path to it is down and never
 * judged the token. Every other status is about access.
 */
const roundTripFailureKind = (
  response: Response,
  detail: string
): HealthCheckError["kind"] => {
  if (response.status >= 500) {
    return "unreachable";
  }
  if (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.get("retry-after") !== null ||
        /rate limit/iu.test(detail)))
  ) {
    return "rate-limited";
  }
  return undefined;
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
          kind: "unreachable",
        }),
    }).pipe(
      // Bound the wait like the ambient probe: a fetch that never settles is
      // unreachability, not health — see ROUND_TRIP_TIMEOUT_MS.
      Effect.timeoutOrElse({
        duration: ROUND_TRIP_TIMEOUT_MS,
        orElse: () =>
          new HealthCheckError({
            stage: "round-trip",
            detail: `GET /repos/${input.repo} did not answer within ${ROUND_TRIP_TIMEOUT_MS / 1000}s`,
            kind: "unreachable",
          }),
      })
    );

    if (!response.ok) {
      // A non-2xx must be explained by its own envelope (or degrade to the
      // status), never fail as a JSON parse complaint — which would drop the
      // status the alert reader needs (5xx = GitHub/proxy down vs 401 =
      // revoked). Parse the body only here, after `response.ok` is known,
      // exactly like the sibling `readBodyJson` helpers in
      // `gh-app-github-api.ts` / `commit-api-core.ts`.
      const payload = yield* Effect.promise(() =>
        response.json().catch(() => null)
      ).pipe(
        Effect.timeoutOrElse({
          duration: ROUND_TRIP_BODY_TIMEOUT_MS,
          orElse: () =>
            Effect.fail(
              new HealthCheckError({
                stage: "round-trip",
                detail: `GET /repos/${input.repo} response body did not arrive within ${ROUND_TRIP_BODY_TIMEOUT_MS / 1000}s`,
                kind: "unreachable",
              })
            ),
        })
      );
      const detail = githubErrorDetail(payload, response.status);
      const kind = roundTripFailureKind(response, detail);
      return yield* new HealthCheckError({
        stage: "round-trip",
        detail,
        ...(kind === undefined ? {} : { kind }),
      });
    }

    const payload = yield* Effect.tryPromise({
      try: (): Promise<unknown> => response.json(),
      catch: (error) =>
        new HealthCheckError({
          stage: "round-trip",
          detail: `repo response was not JSON: ${String(error)}`,
        }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: ROUND_TRIP_BODY_TIMEOUT_MS,
        orElse: () =>
          Effect.fail(
            new HealthCheckError({
              stage: "round-trip",
              detail: `GET /repos/${input.repo} response body did not arrive within ${ROUND_TRIP_BODY_TIMEOUT_MS / 1000}s`,
              // GitHub answered 2xx, so it accepted the token; the answer
              // never finished arriving, which is an outage, not broken auth.
              kind: "unreachable",
            })
          ),
      })
    );

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
      ...(token.expiresAt === undefined
        ? {}
        : { tokenExpiresAt: token.expiresAt }),
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
    failure.kind === "rate-limited"
      ? "GitHub accepted the token but is refusing this App's requests (rate limited) — `git`/`gh` calls fail until the limit resets. The token and the App are fine: find what is spending the request budget (a retry loop, a busy schedule) or wait for the reset."
      : failure.kind === "unreachable"
        ? "GitHub did not answer the round-trip (a timeout, a refused connection or a server error), so the token was never tested. Check the network path to api.github.com and GitHub's status before touching `GH_TOKEN` or the App."
        : "GitHub auth is not working — `git`/`gh` operations will fail until this is fixed. Check that the host is injecting and rotating `GH_TOKEN`, `GITHUB_REPO` in the service env, and the App's installation/repo access.",
  ].join("\n");
};

/**
 * The Slack alert for a failed ambient probe. A rate-limit refusal is an
 * ANSWER from GitHub, so its remedy is the request budget, not the network:
 * pre-fix every ambient failure, a rate limit included, read "GitHub is
 * unreachable … check the host's egress proxy / network path", sending the
 * operator to debug a path that was working.
 *
 * `githubRepo` is the raw (redacted) GITHUB_REPO: when it is set but resolves
 * to no owner/repo, the root fallback is a spelling problem, not a missing
 * variable, and the alert must not tell the operator to set what is set.
 */
export const renderAmbientAlert = (
  failure: AmbientProbeError,
  githubRepo = ""
): string =>
  [
    ":rotating_light: *GitHub ambient access check failed*",
    `Detail: ${failure.detail}`,
    "",
    failure.refused === true
      ? "GitHub refused the credential the host attached to the probe (HTTP 401): ambient access is broken, and the intern's `git`/`gh`/REST calls through it fail. Reconnect or renew the workspace's GitHub connection on the host."
      : failure.rateLimited === true && failure.unscoped === true && githubRepo !== ""
      ? `GitHub answered the probe's \`GET /\` with a rate limit. \`GITHUB_REPO\` is set to "${githubRepo}" but resolves to no owner/repo, so the probe could only ask the unscoped root, and a proxy that attaches its credential per owner sends none there: this does not show that the intern's own repo calls fail. Fix its spelling (bare \`owner/repo\` or the repo's URL) so the probe asks the intern's own repo, the route real work uses.`
      : failure.rateLimited === true && failure.unscoped === true
      ? "GitHub answered the probe's `GET /` with a rate limit. `GITHUB_REPO` is not set, so the probe could only ask the unscoped root, and a proxy that attaches its credential per owner sends none there: this does not show that the intern's own repo calls fail. Set `GITHUB_REPO` so the probe asks the intern's own repo, the route real work uses."
      : failure.rateLimited === true
      ? "GitHub answered but is refusing this workspace's requests (rate limited) — `git`/`gh` calls fail until the limit resets. The network path to api.github.com works: find what is spending the request budget (a retry loop, a busy schedule) or wait for the reset."
      : // A timeout, a refused connection or a 5xx is no answer about the
        // credential, so the alert must not claim access is broken: pre-fix it
        // did, sending the operator to reconnect GitHub during a GitHub
        // outage. Same remedy shape as the App-mode "unreachable" text.
        "GitHub is unreachable from this workspace or failed with a server error (a timeout, a refused connection or a 5xx), so the credential the host attaches was never tested — this does not show that ambient access is broken. Check the host's egress proxy / network path to api.github.com and GitHub's status before touching the workspace's GitHub connection.",
  ].join("\n");

/** One-line, log-friendly success summary (no token material). */
export const formatHealthOkLog = (repo: string, ok: HealthCheckOk): string =>
  `gh-auth-health: ok — token reaches ${ok.repoFullName}${ok.tokenExpiresAt === undefined ? "" : ` (expires ${ok.tokenExpiresAt})`} for ${repo}.`;

/** One-line, log-friendly failure summary (no token material). */
export const formatHealthErrorLog = (
  repo: string,
  failure: HealthCheckError
): string =>
  `gh-auth-health: FAILED at ${failure.stage} for ${repo} — ${failure.detail}`;
