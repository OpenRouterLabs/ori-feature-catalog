import { Effect, Fiber, Option, Schema } from "effect";

import type { PostedMessage, SlackApiError } from "#src/client/client.ts";
import type { RunState } from "#src/message-stream/run-state.ts";

import { bestEffort } from "#src/helpers/index.ts";
import { clampToWord } from "#src/clamp.ts";
import { opaqueSchema } from "#src/schema-support.ts";
import { toolSummary } from "#src/message-stream/run-state.ts";

const NOTICE_AFTER_MS = 20_000;

const RECHECK_MS = 2000;

const FIRST_SENTENCE_LIMIT = 140;

const TOOL_SUMMARY_LIMIT = 90;

const WHITESPACE = /\s+/gu;

const SENTENCE_BREAK = /(?<=[.!?])\s/u;

const SENTENCE_END = /[.!?]$/u;

const TRAILING_STOPS = /[.!?]+$/u;

const firstSentence = (text: string): Option.Option<string> => {
  const trimmed = text.replaceAll(WHITESPACE, " ").trim();
  const [sentence] = trimmed.split(SENTENCE_BREAK);
  if (sentence === undefined || !SENTENCE_END.test(sentence)) {
    return Option.none();
  }
  const withoutStop = sentence.replace(TRAILING_STOPS, "");
  return withoutStop === ""
    ? Option.none()
    : Option.some(clampToWord(withoutStop, FIRST_SENTENCE_LIMIT));
};

export const onItText = (state: RunState): Option.Option<string> => {
  const said = firstSentence(state.text);
  if (Option.isSome(said)) {
    const stop = said.value.endsWith("…") ? "" : ".";
    return Option.some(`On it: ${said.value}${stop}`);
  }
  const tools = toolSummary(state.tools);
  return tools === ""
    ? Option.none()
    : Option.some(`On it — running ${clampToWord(tools, TOOL_SUMMARY_LIMIT)}.`);
};

const OnItNoticeSchema = Schema.Struct({
  stop: opaqueSchema<Effect.Effect<void>>("OnItNotice.stop"),
});

type OnItNotice = typeof OnItNoticeSchema.Type;

const postWhenReady = (input: {
  readonly peek: Effect.Effect<RunState>;
  readonly post: (text: string) => Effect.Effect<PostedMessage, SlackApiError>;
  readonly recheckMs: number;
}): Effect.Effect<void> =>
  input.peek.pipe(
    Effect.flatMap((state) =>
      Option.match(onItText(state), {
        onNone: () =>
          Effect.sleep(input.recheckMs).pipe(
            Effect.andThen(() => postWhenReady(input))
          ),
        onSome: (text) => input.post(text).pipe(bestEffort),
      })
    )
  );

export const armOnItNotice = Effect.fnUntraced(function* (input: {
  readonly delayMs?: number | undefined;
  readonly firstTurn: boolean;
  readonly peek: Effect.Effect<RunState>;
  readonly post: (text: string) => Effect.Effect<PostedMessage, SlackApiError>;
  readonly recheckMs?: number | undefined;
}): Effect.fn.Return<OnItNotice> {
  if (!input.firstTurn) {
    return { stop: Effect.void };
  }

  const fiber = yield* Effect.forkChild(
    Effect.sleep(input.delayMs ?? NOTICE_AFTER_MS).pipe(
      Effect.andThen(() =>
        postWhenReady({
          peek: input.peek,
          post: input.post,
          recheckMs: input.recheckMs ?? RECHECK_MS,
        })
      )
    )
  );

  return { stop: Fiber.interrupt(fiber) };
});
