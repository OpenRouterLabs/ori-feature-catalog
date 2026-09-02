import { Effect } from "effect";

import type { SlackBlock } from "#src/helpers/block-kit/blocks.ts";
import type { MessageReplyShape } from "#src/message-reply/reply.ts";
import type { RunState } from "./run-state.ts";

import { context, markdown } from "#src/helpers/block-kit/blocks.ts";
import { RunPhase, minutesSince, renderRunState } from "./run-state.ts";

const SUPERSEDED: ReadonlySet<RunPhase> = new Set([RunPhase.Steered]);

const answerOf = (state: RunState): string =>
  renderRunState(state, {
    withModel: false,
    withWorkLog: false,
  });

const respondedIn = (state: RunState, now: number): string => {
  const minutes = minutesSince(state.startedAt, now);
  return minutes === 0 ? "<1m" : `${minutes}m`;
};

const smallPrint = (state: RunState, now: number): string =>
  [state.harness ?? "", state.model ?? "", respondedIn(state, now)]
    .filter((part) => part !== "")
    .join(" · ");

const answerBlocks = (state: RunState, now: number): readonly SlackBlock[] => {
  const small = smallPrint(state, now);
  return [markdown(answerOf(state)), ...(small === "" ? [] : [context(small)])];
};

export const settle = Effect.fn("Slack.stream.settle")(function* (input: {
  readonly reply: MessageReplyShape;
  readonly state: RunState;
  readonly superseded: boolean;
  readonly now?: number | undefined;
}): Effect.fn.Return<void> {
  const { reply, state } = input;
  const now = input.now ?? Date.now();
  if (SUPERSEDED.has(state.phase) && input.superseded) {
    return;
  }
  yield* reply.replyBlocks(answerBlocks(state, now), answerOf(state)).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("[slack] could not post the answer", cause)
    ),
    Effect.asVoid
  );
});
