import { Schema } from "effect";

export const GateContextSchema = Schema.Struct({
  botUserId: Schema.UndefinedOr(Schema.String),
  allowedUserIds: Schema.ReadonlySet(Schema.String),
  skipPrefixes: Schema.Array(Schema.String),
});

export type GateContext = typeof GateContextSchema.Type;

export const IncomingMessageSchema = Schema.Struct({
  botId: Schema.UndefinedOr(Schema.String),
  subtype: Schema.UndefinedOr(Schema.String),
  text: Schema.String,
  userId: Schema.UndefinedOr(Schema.String),
});

export type IncomingMessage = typeof IncomingMessageSchema.Type;

type GateDecision =
  | { readonly admit: true }
  | { readonly admit: false; readonly reason: string };

const ADMIT: GateDecision = { admit: true };

const IGNORED_SUBTYPES: ReadonlySet<string> = new Set([
  "channel_join",
  "channel_leave",
  "message_changed",
  "message_deleted",
  "thread_broadcast",
]);

export const asideOf = (
  text: string,
  prefixes: readonly string[]
): string | undefined => {
  const trimmed = text.trimStart();
  return prefixes.find((prefix) => trimmed.startsWith(prefix));
};

export const admitMessage = (
  message: IncomingMessage,
  context: GateContext
): GateDecision => {
  if (message.subtype !== undefined && IGNORED_SUBTYPES.has(message.subtype)) {
    return {
      admit: false,
      reason: `subtype:${message.subtype}`,
    };
  }

  if (context.botUserId !== undefined && message.userId === context.botUserId) {
    return {
      admit: false,
      reason: "self",
    };
  }

  if (message.botId !== undefined) {
    return {
      admit: false,
      reason: "bot",
    };
  }

  if (message.text.trim() === "") {
    return {
      admit: false,
      reason: "empty",
    };
  }

  const skipped = asideOf(message.text, context.skipPrefixes);
  if (skipped !== undefined) {
    return {
      admit: false,
      reason: `prefix:${skipped}`,
    };
  }

  if (
    context.allowedUserIds.size > 0 &&
    (message.userId === undefined ||
      !context.allowedUserIds.has(message.userId))
  ) {
    return {
      admit: false,
      reason: "not-allowed",
    };
  }

  return ADMIT;
};

export const gateContextOf = (config: {
  readonly allowedUserIds: ReadonlySet<string>;
  readonly botUserId: string | undefined;
  readonly skipPrefixes: readonly string[];
}): GateContext => ({
  allowedUserIds: config.allowedUserIds,
  botUserId: config.botUserId,
  skipPrefixes: config.skipPrefixes,
});
