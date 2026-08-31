/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * thread.ts — thread identity and per-turn context.
 *
 * The RFC's position, and the reason this is a service rather than a helper:
 * the Slack thread is NOT the agent's canonical context. The agent session is.
 * A thread maps to exactly one session, and each turn sends only the new Slack
 * input; prior turns live in the session, not in a re-serialised transcript.
 *
 * Reading the thread is therefore a COLD-START path only — the case where no
 * session exists yet (the bot is mentioned into a conversation already in
 * progress). After that the agent can pull older messages on demand through
 * the `slack-api` skill rather than having them replayed into every prompt.
 */

import { Context, Effect, Schema } from "effect";

import { clampToWord } from "../clamp.ts";
import { SlackClient } from "../client/index.ts";

/** Everything needed to address a thread and route a reply back to it. */
export interface ThreadRef {
  readonly channelId: string;
  readonly teamId: string;
  readonly threadTs: string;
}

/**
 * Every fence this codebase wraps untrusted text in. A filename sanitised for
 * one fence but dropped inside another escapes just as easily, so the sanitiser
 * neutralises all of them regardless of which caller is asking.
 */
const FENCE_TAGS =
  /<\s*\/?\s*(slack_thread|untrusted_file_content|interrupted_ask|slack_thread_ref)\s*>/giu;

/**
 * Sanitise external text before it lands inside a prompt fence.
 *
 * A thread body, a user's display name, and a filename are all
 * attacker-controlled. Text containing a literal closing tag would otherwise
 * CLOSE the wrapper early, and a forged divider after it would render outside
 * the fence as trusted prompt scaffolding. The invariant is simply that
 * external data can never close or forge its own wrapper.
 */
export const sanitizeThreadContent = (value: string): string =>
  value
    .replaceAll(FENCE_TAGS, (_match, tag: string) => tag)
    .replaceAll(/^[^\S\n]*-{3,}[^\S\n]*$/gmu, "- - -");

/** A canonical, collision-free id for the session bound to a thread. */
export const threadInstanceId = (ref: ThreadRef): string =>
  `slack:${ref.teamId}:${ref.channelId}:${ref.threadTs}`;

/**
 * Recover the thread a session id names. The exact inverse of
 * {@link threadInstanceId}, which `thread.test.ts` pins by round-trip.
 *
 * The turn registry keys everything by this id — it is the canonical thread
 * identity, so decoding it is how a surface that reports on running turns (the
 * App Home tab) learns which channel each one is in, rather than every layer
 * between carrying a duplicate copy of the ref.
 */
export const parseThreadInstanceId = (id: string): ThreadRef | undefined => {
  const [scheme, teamId, channelId, threadTs] = id.split(":");
  return scheme !== "slack" ||
    teamId === undefined ||
    channelId === undefined ||
    threadTs === undefined ||
    threadTs === ""
    ? undefined
    : {
        channelId,
        teamId,
        threadTs,
      };
};

interface ThreadContextShape {
  /**
   * The context block prepended to a COLD-START turn. Returns "" when a
   * session already exists, which is the common case.
   */
  readonly build: (
    input: ThreadRef & {
      readonly hasSession: boolean;
      readonly startsThread?: boolean | undefined;
    }
  ) => Effect.Effect<string>;

  readonly instanceId: (ref: ThreadRef) => string;
}

export class ThreadContext extends Context.Service<
  ThreadContext,
  ThreadContextShape
>()("ori/slack/ThreadContext") {}

/** Cap on a cold-start read. Slack's page cap is lower for unlisted apps. */
const COLD_START_MESSAGE_LIMIT = 15;

/**
 * Ceiling on the cold-start read, because it sits in front of the agent.
 *
 * `conversations.replies` allows one call a minute for an unlisted app, and a
 * 429 is retried by the client — so without a bound, fetching context the
 * answer may not even need delays every reply in a busy channel. Context is
 * cosmetic; the turn is not.
 */
const HISTORY_TIMEOUT_MS = 3000;

const Reply = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  user: Schema.optionalKey(Schema.String),
});
const decodeReplies = Schema.decodeUnknownOption(Schema.Array(Reply));

/**
 * Cold-start history budget, in tokens.
 *
 * The count limit above bounds the READ; this bounds what reaches the model,
 * and they are different problems. Fifteen messages is nothing until someone
 * pastes a stack trace, and then a block sized in messages is unbounded in
 * the only dimension that costs anything.
 *
 * 30k matches where Mastra starts compacting a conversation buffer. It is
 * deliberately generous: a thread the bot was pulled into late is exactly
 * the case where orientation is worth paying for, and the read above already
 * caps the damage at fifteen messages. What the agent still cannot get from
 * here it can read with `slack-api conversations.replies`, which the omission
 * marker points it at.
 */
const HISTORY_TOKEN_BUDGET = 30_000;

/**
 * No one message may take more than an even share of the block.
 *
 * Derived rather than picked: a per-message cap chosen independently either
 * binds before the block budget ever does — making the block budget
 * decoration — or lets a single paste crowd out the fourteen messages around
 * it. An even share is the only ratio that does neither.
 */
const PER_MESSAGE_TOKEN_BUDGET = Math.floor(
  HISTORY_TOKEN_BUDGET / COLD_START_MESSAGE_LIMIT
);

/**
 * Characters per token, deliberately pessimistic.
 *
 * ~4 holds for English prose; thread history is not that. It is prose mixed
 * with pasted logs, JSON and Slack ids like `U08ABC123`, all of which
 * tokenize far worse than prose. Estimating 3 spends the budget early rather
 * than overshooting it, and overshooting is the failure that matters — a real
 * tokenizer would be a dependency for arithmetic the repo can own.
 */
const CHARS_PER_TOKEN = 3;

const estimateTokens = (text: string): number =>
  Math.ceil(text.length / CHARS_PER_TOKEN);

const budgetToChars = (tokens: number): number => tokens * CHARS_PER_TOKEN;

/**
 * The history block, or "" when there is nothing usable in it.
 *
 * Every field is sanitized: this text came from other people in the channel
 * and lands in the model's context, so it is data, never instructions.
 *
 * Kept NEWEST-first while filling the budget, then reversed back into reading
 * order. What a turn needs is the end of the conversation it just joined; the
 * opening of a long thread is the part it can afford to lose.
 */
const renderHistory = (messages: readonly unknown[]): string => {
  const decoded = decodeReplies(messages);
  if (decoded._tag !== "Some" || decoded.value.length === 0) {
    return "";
  }

  const lines = decoded.value.map((message) => {
    const speaker = sanitizeThreadContent(message.user ?? "unknown");
    const text = sanitizeThreadContent(message.text ?? "");
    return clampToWord(
      `${speaker}: ${text}`,
      budgetToChars(PER_MESSAGE_TOKEN_BUDGET)
    );
  });

  const kept: string[] = [];
  let spent = 0;
  for (const line of [...lines].toReversed()) {
    const cost = estimateTokens(line);
    if (spent + cost > HISTORY_TOKEN_BUDGET) {
      break;
    }
    spent += cost;
    kept.push(line);
  }
  kept.reverse();

  if (kept.length === 0) {
    return "";
  }

  // Named rather than silently dropped: an agent that knows it is missing the
  // start of a thread can go and read it, and one that does not will answer
  // confidently from half a conversation.
  const dropped = lines.length - kept.length;
  const omitted =
    dropped === 0
      ? []
      : [
          `[${dropped} earlier message${dropped === 1 ? "" : "s"} omitted — read them with slack-api conversations.replies]`,
        ];

  return `<slack_thread>\n${[...omitted, ...kept].join("\n")}\n</slack_thread>`;
};

export const ThreadContextLive = Effect.gen(function* () {
  const slack = yield* SlackClient;

  const build: ThreadContextShape["build"] = Effect.fn("Slack.thread.build")(
    function* (input) {
      // A live session already holds the conversation. Re-sending it every
      // turn is the context bloat this design exists to avoid.
      if (input.hasSession) {
        return "";
      }

      // A mention that opened the thread is the only message in it, so the
      // read can only return that mention back. Skipping it takes a
      // rate-limited round-trip off the front of every cold start.
      if (input.startsThread === true) {
        return "";
      }

      const page = yield* Effect.tryPromise({
        catch: (cause) =>
          new Error(`conversations.replies failed: ${String(cause)}`),
        try: () =>
          slack.raw.conversations.replies({
            channel: input.channelId,
            limit: COLD_START_MESSAGE_LIMIT,
            ts: input.threadTs,
          }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: HISTORY_TIMEOUT_MS,
          orElse: () =>
            Effect.logWarning(
              "[slack] thread history took too long; starting without context"
            ).pipe(Effect.andThen(Effect.succeed({ messages: [] }))),
        }),
        // Context is cosmetic: a failed read must never abort a turn. It is
        // logged rather than ignored because the likely cause is a rate limit
        // — `conversations.replies` allows one call a minute for an unlisted
        // app — and the symptom is a bot that silently forgets the thread it
        // is standing in, which is otherwise very hard to attribute.
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "[slack] could not read thread history; starting without context",
            cause
          ).pipe(Effect.andThen(Effect.succeed({ messages: [] })))
        )
      );

      return renderHistory(page.messages ?? []);
    }
  );

  return ThreadContext.of({
    build,
    instanceId: threadInstanceId,
  });
}).pipe(Effect.withSpan("Slack.thread.threadContextLive"));
