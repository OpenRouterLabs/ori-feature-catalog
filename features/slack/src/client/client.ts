import type {
  AssistantThreadsSetStatusArguments,
  AssistantThreadsSetTitleArguments,
  ChatPostMessageArguments,
  ChatUpdateArguments,
  ViewsOpenArguments,
  WebClient,
} from "@slack/web-api";
import { Context, type Effect, Schema } from "effect";


import { functionSchema, opaqueSchema } from "#src/schema-support.ts";

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

const PostedMessageSchema = Schema.Struct({
  channel: Schema.String,
  ts: Schema.String,
});

export type PostedMessage = typeof PostedMessageSchema.Type;

export const SlackClientShapeSchema = Schema.Struct({
  postMessage:
    functionSchema<
      (
        args: ChatPostMessageArguments
      ) => Effect.Effect<PostedMessage, SlackApiError>
    >("SlackClientShape.postMessage"),

  deleteMessage:
    functionSchema<
      (args: {
        readonly channel: string;
        readonly ts: string;
      }) => Effect.Effect<void, SlackApiError>
    >("SlackClientShape.deleteMessage"),

  updateMessage:
    functionSchema<
      (args: ChatUpdateArguments) => Effect.Effect<void, SlackApiError>
    >("SlackClientShape.updateMessage"),

  openView:
    functionSchema<
      (args: ViewsOpenArguments) => Effect.Effect<void, SlackApiError>
    >("SlackClientShape.openView"),

  setAssistantStatus:
    functionSchema<
      (
        args: AssistantThreadsSetStatusArguments
      ) => Effect.Effect<void, SlackApiError>
    >("SlackClientShape.setAssistantStatus"),

  setAssistantTitle:
    functionSchema<
      (
        args: AssistantThreadsSetTitleArguments
      ) => Effect.Effect<void, SlackApiError>
    >("SlackClientShape.setAssistantTitle"),

  getUserName:
    functionSchema<(userId: string) => Effect.Effect<string, SlackApiError>>(
      "SlackClientShape.getUserName"
    ),

  raw: opaqueSchema<WebClient>("SlackClientShape.raw"),
});

export type SlackClientShape = typeof SlackClientShapeSchema.Type;

export class SlackClient extends Context.Service<
  SlackClient,
  SlackClientShape
>()("ori/slack/SlackClient") {}
