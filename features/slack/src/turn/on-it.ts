import { Effect, Fiber, Option, Schema } from "effect";

import type { PostedMessage, SlackApiError } from "#src/client/client.ts";
import type { RunState } from "#src/message-stream/run-state.ts";

import { bestEffort } from "#src/helpers/index.ts";
import { clampToWord } from "#src/clamp.ts";
import { opaqueSchema } from "#src/schema-support.ts";
import { toolSummary } from "#src/message-stream/run-state.ts";

/**
 * How long a turn runs before the thread is told anything. Short enough that a
 * person has not yet wondered whether the message landed, long enough that an
 * answer arriving on its own never races a notice about itself.
 */
const NOTICE_AFTER_MS = 20_000;

const FIRST_SENTENCE_LIMIT = 140;

const TOOL_SUMMARY_LIMIT = 90;

/**
 * An opener carries no request. Answering one takes a sentence, so a notice
 * about how long it is taking would be the longer message of the two.
 */
const OPENERS = new Set([
  "gm",
  "hey",
  "hey there",
  "hello",
  "hello there",
  "hi",
  "hi there",
  "howdy",
  "morning",
  "sup",
  "yo",
  "good morning",
  "good afternoon",
  "good evening",
]);

/**
 * An acknowledgement closes a turn rather than opening one, so it gets the
 * same silence for the same reason.
 */
const CLOSERS = new Set([
  "cheers",
  "cool",
  "great",
  "k",
  "nice",
  "ok",
  "okay",
  "perfect",
  "sweet",
  "thank you",
  "thanks",
  "thx",
  "ty",
]);

const NON_WORD = /[^\p{L}\p{N}\s]/gu;

const normalizedAsk = (ask: string): string =>
  ask.replaceAll(NON_WORD, "").replaceAll(/\s+/gu, " ").trim().toLowerCase();

export const isSmallTalk = (ask: string): boolean => {
  const normalized = normalizedAsk(ask);
  if (normalized === "") {
    return true;
  }
  if (OPENERS.has(normalized) || CLOSERS.has(normalized)) {
    return true;
  }
  // "hey ori", "thanks ori" -- the same two turns with the bot named.
  const withoutName = normalized.replace(/\s+ori$/u, "");
  return OPENERS.has(withoutName) || CLOSERS.has(withoutName);
};

const SENTENCE_BREAK = /(?<=[.!?])\s/u;

/**
 * The model's own first sentence, which is the only part of a long turn that
 * says what it decided to do. A fragment still being typed is not one: it
 * would be cut mid-thought, and the next poll would not correct it because the
 * notice is posted once.
 */
const firstSentence = (text: string): Option.Option<string> => {
  const trimmed = text.replaceAll(/\s+/gu, " ").trim();
  const [sentence] = trimmed.split(SENTENCE_BREAK);
  if (sentence === undefined || !/[.!?]$/u.test(sentence)) {
    return Option.none();
  }
  const withoutStop = sentence.replace(/[.!?]+$/u, "");
  return withoutStop === ""
    ? Option.none()
    : Option.some(clampToWord(withoutStop, FIRST_SENTENCE_LIMIT));
};

/**
 * What the turn is actually doing, in the model's words if it has said any and
 * in the names of the tools it is running otherwise. Nothing is invented: with
 * neither of those the turn has produced no signal, and `Option.none` keeps the
 * thread quiet rather than posting "working on it".
 */
export const onItText = (input: {
  readonly ask: string;
  readonly state: RunState;
}): Option.Option<string> => {
  if (isSmallTalk(input.ask)) {
    return Option.none();
  }
  const said = firstSentence(input.state.text);
  if (Option.isSome(said)) {
    // A clamped sentence already ends in an ellipsis; a full stop after it
    // would read as a fourth dot.
    const stop = said.value.endsWith("…") ? "" : ".";
    return Option.some(`On it: ${said.value}${stop}`);
  }
  const tools = toolSummary(input.state.tools);
  return tools === ""
    ? Option.none()
    : Option.some(`On it — running ${clampToWord(tools, TOOL_SUMMARY_LIMIT)}.`);
};

const OnItNoticeSchema = Schema.Struct({
  stop: opaqueSchema<Effect.Effect<void>>("OnItNotice.stop"),
});

type OnItNotice = typeof OnItNoticeSchema.Type;

/**
 * Posts one message into the thread when a turn has been running long enough
 * to be worth explaining and has produced something worth saying. Posted once:
 * a second notice is the status line's job, and it already beats every 8s.
 */
export const armOnItNotice = Effect.fnUntraced(function* (input: {
  readonly ask: string;
  readonly delayMs?: number | undefined;
  readonly peek: Effect.Effect<RunState>;
  readonly post: (
    text: string
  ) => Effect.Effect<PostedMessage, SlackApiError>;
}): Effect.fn.Return<OnItNotice> {
  const fiber = yield* Effect.forkChild(
    Effect.sleep(input.delayMs ?? NOTICE_AFTER_MS).pipe(
      Effect.andThen(() =>
        input.peek.pipe(
          Effect.flatMap((state) =>
            Option.match(onItText({ ask: input.ask, state }), {
              onNone: () => Effect.void,
              onSome: (text) => input.post(text).pipe(bestEffort),
            })
          )
        )
      )
    )
  );

  return { stop: Fiber.interrupt(fiber) };
});
