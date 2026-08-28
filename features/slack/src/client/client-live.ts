/**
 * client-live.ts — the live `SlackClient` adapter over `@slack/web-api`.
 *
 * Owns three things the port deliberately does not: how the `WebClient` is
 * configured, how a thrown SDK error becomes a typed `SlackApiError`, and the
 * transient-aware retry around each call.
 */

import type {
  AssistantThreadsSetStatusArguments,
  AssistantThreadsSetTitleArguments,
  ChatPostMessageArguments,
  ChatUpdateArguments,
  ViewsOpenArguments,
} from "@slack/web-api";

import { retryPolicies, WebClient } from "@slack/web-api";
import { Duration, Effect, Layer, Schedule, Schema } from "effect";

import type { PostedMessage, SlackClientShape } from "./client.ts";

import { SlackApiError, SlackClient, SlackConfigError } from "./client.ts";
import { resolveSlackProxyAgent } from "./proxy-agent.ts";

/** Per-attempt HTTP timeout. The SDK default is `0` — no timeout at all. */
const REQUEST_TIMEOUT_MS = 15_000;

const RETRY_BASE_DELAY_MS = 200;
const RETRY_ATTEMPTS = 3;

/**
 * Ceiling on one logical call including every retry beneath it. Slack's own
 * rate-limit backoff is worth keeping — it honours `Retry-After`, which our
 * exponential schedule does not — so this bounds the total instead of
 * disabling it.
 */
const CALL_BUDGET_MS = 90_000;

/**
 * `new WebClient(token)` inherits `retryConfig: tenRetriesInAboutThirtyMinutes`
 * and `timeout: 0`, and `rejectRateLimitedCalls` is false — so a 429 does not
 * throw, it sleeps inside the SDK for roughly half an hour and surfaces
 * nothing. On an interactive surface that reads as a turn that never finishes.
 *
 * A bounded policy plus a per-attempt timeout caps the damage. Note the
 * timeout applies per attempt, not to the total retry period, so the bounded
 * policy is doing most of the work.
 */
export const makeConfiguredWebClient = (
  token: string,
  env: Readonly<Record<string, string | undefined>> = Bun.env
): WebClient => {
  /* The header is what the vault sidecar substitutes; `undefined` keeps the
     SDK from writing its own. */
  return new WebClient(undefined, {
    agent: resolveSlackProxyAgent(env),
    headers: { Authorization: `Bearer ${token}` },
    retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
    timeout: REQUEST_TIMEOUT_MS,
  });
};

/**
 * The Slack SDK reports logical failures as a thrown error carrying
 * `data.error` — the platform code — rather than as a rejected HTTP status,
 * because the Web API answers 200 for those. Decode defensively: a malformed
 * `data` must still let a rate-limit `code` win.
 */
const SdkError = Schema.Struct({
  code: Schema.optionalKey(Schema.Unknown),
  data: Schema.optionalKey(Schema.Unknown),
});
const decodeSdkError = Schema.decodeUnknownOption(SdkError);

const slackCode = (cause: unknown): string => {
  const decoded = decodeSdkError(cause);
  if (decoded._tag !== "Some") {
    return "unknown";
  }
  const { code, data } = decoded.value;
  if (typeof data === "object" && data !== null && "error" in data) {
    const { error } = data;
    if (typeof error === "string") {
      return error;
    }
  }
  return typeof code === "string" ? code : "unknown";
};

/**
 * One logical call: the SDK promise, the transient retry, the total budget.
 *
 * The span sits outermost and is named from `op`, so every method on the port
 * is traced here once rather than nine times, retries included.
 */
const call = <A>(
  op: string,
  run: () => Promise<A>
): Effect.Effect<A, SlackApiError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new SlackApiError({
        cause,
        code: slackCode(cause),
        op,
      }),
  }).pipe(
    Effect.retry({
      schedule: Schedule.exponential(Duration.millis(RETRY_BASE_DELAY_MS), 2),
      times: RETRY_ATTEMPTS,
      while: (error: SlackApiError) => error.transient,
    }),
    // The SDK runs its own five-minute retry policy INSIDE each of the
    // attempts above, so the two policies multiply: worst case a single
    // logical call could sit for twenty minutes. The per-attempt HTTP timeout
    // does not bound that, because it applies to one request, not the retry
    // period. This caps the whole thing.
    Effect.timeoutOrElse({
      duration: Duration.millis(CALL_BUDGET_MS),
      orElse: () =>
        Effect.fail(
          new SlackApiError({
            cause: new Error(`${op} exceeded ${CALL_BUDGET_MS}ms`),
            code: "call_budget_exceeded",
            op,
          })
        ),
    }),
    Effect.withSpan(`Slack.client.${op}`)
  );

/**
 * The methods behind the App Home tab and the assistant pane.
 *
 * Grouped because they are the surfaces a reader reaches outside a channel
 * thread, and because three of them share one property nothing else on this
 * port does: Slack answers `not_allowed` outside an assistant container, so
 * they are only ever reached through the gate in `assistant.ts`.
 */
const assistantMethods = (
  client: WebClient
): Pick<SlackClientShape, "setAssistantStatus" | "setAssistantTitle"> => ({
  setAssistantStatus: (
    args: AssistantThreadsSetStatusArguments
  ): Effect.Effect<void, SlackApiError> =>
    call("assistant.threads.setStatus", () =>
      client.assistant.threads.setStatus(args)
    ).pipe(Effect.asVoid),

  setAssistantTitle: (
    args: AssistantThreadsSetTitleArguments
  ): Effect.Effect<void, SlackApiError> =>
    call("assistant.threads.setTitle", () =>
      client.assistant.threads.setTitle(args)
    ).pipe(Effect.asVoid),
});

const makeSlackClient = (client: WebClient): SlackClientShape => ({
  getUserName: (userId: string): Effect.Effect<string, SlackApiError> =>
    call("users.info", () => client.users.info({ user: userId })).pipe(
      Effect.map((response) => {
        const profile = response.user?.profile;
        return (
          (profile?.display_name ?? "").trim() ||
          (profile?.real_name ?? "").trim() ||
          userId
        );
      })
    ),
  openView: (args: ViewsOpenArguments): Effect.Effect<void, SlackApiError> =>
    call("views.open", () => client.views.open(args)).pipe(Effect.asVoid),
  ...assistantMethods(client),
  postMessage: (
    args: ChatPostMessageArguments
  ): Effect.Effect<PostedMessage, SlackApiError> =>
    call("chat.postMessage", () => client.chat.postMessage(args)).pipe(
      Effect.flatMap((response) =>
        // A post with no `ts` is not a usable message: every later edit
        // addresses it by `ts`, so defaulting to "" would hand back a handle
        // that silently fails on every update for the rest of the turn.
        // Failing here lets the caller fall back to posting anew.
        response.ts === undefined
          ? Effect.fail(
              new SlackApiError({
                cause: new Error("chat.postMessage returned no ts"),
                code: "missing_ts",
                op: "chat.postMessage",
              })
            )
          : Effect.succeed({
              channel: response.channel ?? "",
              ts: response.ts,
            } satisfies PostedMessage)
      )
    ),

  // Escape hatch: the same configured instance the typed methods use, so a
  // caller reaching past this surface cannot land on an unconfigured client.
  raw: client,

  deleteMessage: (args: {
    readonly channel: string;
    readonly ts: string;
  }): Effect.Effect<void, SlackApiError> =>
    call("chat.delete", () =>
      client.chat.delete({
        channel: args.channel,
        ts: args.ts,
      })
    ).pipe(Effect.asVoid),

  updateMessage: (
    args: ChatUpdateArguments
  ): Effect.Effect<void, SlackApiError> =>
    call("chat.update", () => client.chat.update(args)).pipe(Effect.asVoid),
});

/** Provide `SlackClient` from a concrete WebClient. Tests inject a fake here. */
export const SlackClientLive = (client: WebClient): Layer.Layer<SlackClient> =>
  Layer.succeed(SlackClient)(SlackClient.of(makeSlackClient(client)));

/**
 * The service value for a token, without going through a Layer.
 *
 * The composition root holds the built services for the process lifetime
 * (see `index.ts` — `StateStore` must survive between turns), so it needs the
 * value rather than a layer to provide per turn.
 */
export const makeSlackClientFromToken = (token: string): SlackClientShape =>
  makeSlackClient(makeConfiguredWebClient(token));

export const readSlackBotToken = (
  env: Readonly<Record<string, string | undefined>> = Bun.env
): Effect.Effect<string, SlackConfigError> =>
  Effect.suspend(() => {
    const token = env.SLACK_BOT_TOKEN;
    return token === undefined || token === ""
      ? Effect.fail(
          new SlackConfigError({
            message: "Missing env var: SLACK_BOT_TOKEN",
            op: "config",
          })
        )
      : Effect.succeed(token);
  }).pipe(Effect.withSpan("Slack.client.readSlackBotToken"));
