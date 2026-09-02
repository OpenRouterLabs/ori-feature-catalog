import { Effect } from "effect";

import { type AssistantThreadsShape, keyOf, type PaneContext, type ThreadRef, titleFromMessage } from "#src/thread/index.ts";


export const paneOf = (
  ref: ThreadRef
): { readonly channelId: string; readonly threadTs: string } => ({
  channelId: ref.channelId,
  threadTs: ref.threadTs,
});

export const paneContextBlock = (
  paneContext: PaneContext | undefined
): string =>
  paneContext?.channelId === undefined
    ? ""
    : `You are in an assistant pane opened from <#${paneContext.channelId}>. If the reader says "this channel" or "this thread" without naming one, they mean that channel — not this pane.`;

export const openPane = Effect.fn("Slack.turn.openPane")(function* (input: {
  readonly assistant: AssistantThreadsShape;
  readonly firstTurn: boolean;
  readonly ref: ThreadRef;
  readonly text: string;
}) {
  const pane = paneOf(input.ref);

  yield* input.assistant.setStatus(pane, "is thinking…", ["is thinking…"]);

  if (input.firstTurn) {
    yield* input.assistant.setTitle(pane, titleFromMessage(input.text));
  }

  return yield* input.assistant.contextFor(keyOf(pane));
});
