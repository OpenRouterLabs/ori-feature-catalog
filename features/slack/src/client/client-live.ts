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

const REQUEST_TIMEOUT_MS = 15_000;

const RETRY_BASE_DELAY_MS = 200;
const RETRY_ATTEMPTS = 3;

const CALL_BUDGET_MS = 90_000;

export const makeConfiguredWebClient = (
  token: string,
  env: Readonly<Record<string, string | undefined>>
): WebClient => {
  return new WebClient(undefined, {
    agent: resolveSlackProxyAgent(env),
    headers: { Authorization: `Bearer ${token}` },
    retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
    timeout: REQUEST_TIMEOUT_MS,
  });
};

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

export const SlackClientLive = (client: WebClient): Layer.Layer<SlackClient> =>
  Layer.succeed(SlackClient)(SlackClient.of(makeSlackClient(client)));

export const makeSlackClientFromToken = (
  token: string,
  env: Readonly<Record<string, string | undefined>>
): SlackClientShape => makeSlackClient(makeConfiguredWebClient(token, env));

export const readSlackBotToken = (
  env: Readonly<Record<string, string | undefined>>
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
