import type {
  AssistantThreadsSetStatusArguments,
  AssistantThreadsSetTitleArguments,
  ChatPostMessageArguments,
  ChatUpdateArguments,
  ViewsOpenArguments,
  WebClient,
} from "@slack/web-api";
import type { Effect } from "effect";

import { Context, Schema } from "effect";

const TRANSIENT_SLACK_CODES: ReadonlySet<string> = new Set([
  "fatal_error",
  "internal_error",
  "ratelimited",
  "request_timeout",
  "service_unavailable",
]);

export class SlackApiError extends Schema.TaggedErrorClass<SlackApiError>()(
  "SlackApiError",
  {
    op: Schema.String,
    code: Schema.String,
    cause: Schema.Defect(),
  }
) {
  get transient(): boolean {
    return TRANSIENT_SLACK_CODES.has(this.code);
  }
}

export class SlackConfigError extends Schema.TaggedErrorClass<SlackConfigError>()(
  "SlackConfigError",
  {
    op: Schema.String,
    message: Schema.String,
  }
) {}

export interface PostedMessage {
  readonly channel: string;
  readonly ts: string;
}

export interface SlackClientShape {
  readonly postMessage: (
    args: ChatPostMessageArguments
  ) => Effect.Effect<PostedMessage, SlackApiError>;

  readonly deleteMessage: (args: {
    readonly channel: string;
    readonly ts: string;
  }) => Effect.Effect<void, SlackApiError>;

  readonly updateMessage: (
    args: ChatUpdateArguments
  ) => Effect.Effect<void, SlackApiError>;

  readonly openView: (
    args: ViewsOpenArguments
  ) => Effect.Effect<void, SlackApiError>;

  readonly setAssistantStatus: (
    args: AssistantThreadsSetStatusArguments
  ) => Effect.Effect<void, SlackApiError>;

  readonly setAssistantTitle: (
    args: AssistantThreadsSetTitleArguments
  ) => Effect.Effect<void, SlackApiError>;

  readonly getUserName: (
    userId: string
  ) => Effect.Effect<string, SlackApiError>;

  readonly raw: WebClient;
}

export class SlackClient extends Context.Service<
  SlackClient,
  SlackClientShape
>()("ori/slack/SlackClient") {}
