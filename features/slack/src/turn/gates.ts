/**
 * gates.ts — whether to answer at all.
 *
 * The RFC covers how to answer; this covers whether. Every gate here exists
 * because skipping it produces a specific, observed failure:
 *
 *   - Without the self check, the bot answers its own messages and loops.
 *   - Without the bot check, two bots in a channel can ping-pong forever.
 *   - Without the allowlist, anyone in any channel the app is in can spend
 *     model budget.
 *   - Without the prefix skip, `//` scratch notes start turns.
 *
 * Gates are pure predicates over a decoded event so they are trivially
 * testable and cannot themselves fail a turn.
 */

export interface GateContext {
  /** This app's own bot user id, when known. */
  readonly botUserId: string | undefined;
  /** Allowed user ids; empty means unrestricted. */
  readonly allowedUserIds: ReadonlySet<string>;
  /** Text prefixes that mark a message as not-for-the-agent. */
  readonly skipPrefixes: readonly string[];
}

export interface IncomingMessage {
  readonly botId: string | undefined;
  readonly subtype: string | undefined;
  readonly text: string;
  readonly userId: string | undefined;
}

export type GateDecision =
  | { readonly admit: true }
  | { readonly admit: false; readonly reason: string };

const ADMIT: GateDecision = { admit: true };

/**
 * `message_changed`, `message_deleted`, `channel_join` and friends are not
 * user turns. Slack sends them to the same subscription.
 */
const IGNORED_SUBTYPES: ReadonlySet<string> = new Set([
  "channel_join",
  "channel_leave",
  "message_changed",
  "message_deleted",
  "thread_broadcast",
]);

/**
 * The prefix marking this text as an aside, if any: written in the thread but
 * addressed to nobody. Shared with `listen.ts`, where an aside must also not
 * count as somebody joining the conversation.
 */
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

  // Our own message coming back through the events stream.
  if (context.botUserId !== undefined && message.userId === context.botUserId) {
    return {
      admit: false,
      reason: "self",
    };
  }

  // Any other app. Two agents in one channel will otherwise answer each other
  // indefinitely, and each exchange costs a model call.
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

/** The gate-relevant slice of the decoded config. */
export const gateContextOf = (config: {
  readonly allowedUserIds: ReadonlySet<string>;
  readonly botUserId: string | undefined;
  readonly skipPrefixes: readonly string[];
}): GateContext => ({
  allowedUserIds: config.allowedUserIds,
  botUserId: config.botUserId,
  skipPrefixes: config.skipPrefixes,
});
