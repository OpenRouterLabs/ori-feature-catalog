import { Context, Effect, Schema } from "effect";

import { clampToWord } from "#src/clamp.ts";
import { SlackClient } from "#src/client/index.ts";

export interface ThreadRef {
  readonly channelId: string;
  readonly teamId: string;
  readonly threadTs: string;
}

const FENCE_TAGS =
  /<\s*\/?\s*(slack_thread|untrusted_file_content|interrupted_ask|slack_thread_ref)\s*>/giu;

export const sanitizeThreadContent = (value: string): string =>
  value
    .replaceAll(FENCE_TAGS, (_match, tag: string) => tag)
    .replaceAll(/^[^\S\n]*-{3,}[^\S\n]*$/gmu, "- - -");

export const threadInstanceId = (ref: ThreadRef): string =>
  `slack:${ref.teamId}:${ref.channelId}:${ref.threadTs}`;

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

const COLD_START_MESSAGE_LIMIT = 15;

const HISTORY_TIMEOUT_MS = 3000;

const Reply = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  user: Schema.optionalKey(Schema.String),
});
const decodeReplies = Schema.decodeUnknownOption(Schema.Array(Reply));

const HISTORY_TOKEN_BUDGET = 30_000;

const PER_MESSAGE_TOKEN_BUDGET = Math.floor(
  HISTORY_TOKEN_BUDGET / COLD_START_MESSAGE_LIMIT
);

const CHARS_PER_TOKEN = 3;

const estimateTokens = (text: string): number =>
  Math.ceil(text.length / CHARS_PER_TOKEN);

const budgetToChars = (tokens: number): number => tokens * CHARS_PER_TOKEN;

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
      if (input.hasSession) {
        return "";
      }

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
