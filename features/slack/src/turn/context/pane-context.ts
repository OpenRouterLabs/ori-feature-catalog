/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * pane-context.ts — telling a pane turn which channel it was opened from.
 *
 * Split from `handler.ts` so that file stays about the shape of a turn: this
 * is one line of prompt copy that belongs to the assistant surface.
 */

import { Effect } from "effect";

import type {
  AssistantThreadsShape,
  PaneContext,
} from "../../thread/assistant.ts";
import type { ThreadRef } from "../../thread/thread.ts";

import { keyOf, titleFromMessage } from "../../thread/assistant.ts";

/** The pane coordinates for a thread, which the assistant calls take. */
export const paneOf = (
  ref: ThreadRef
): { readonly channelId: string; readonly threadTs: string } => ({
  channelId: ref.channelId,
  threadTs: ref.threadTs,
});

/**
 * What the reader was looking at when they opened the assistant pane.
 *
 * The pane is its own conversation, so "summarise this" in it has no referent
 * without this line — the agent would otherwise answer about the pane, which
 * contains only the question. Not sanitised because it holds nothing but ids
 * Slack itself supplied.
 */
export const paneContextBlock = (
  paneContext: PaneContext | undefined
): string =>
  paneContext?.channelId === undefined
    ? ""
    : `You are in an assistant pane opened from <#${paneContext.channelId}>. If the reader says "this channel" or "this thread" without naming one, they mean that channel — not this pane.`;

/**
 * Prepare the assistant pane for a turn, and report what is behind it.
 *
 * Every call is a no-op outside a pane, so the turn path needs no branch. All
 * three exist because the pane frame is otherwise blank while a run is live and
 * unnamed in the reader's history forever after.
 */
export const openPane = Effect.fn("Slack.turn.openPane")(function* (input: {
  readonly assistant: AssistantThreadsShape;
  readonly firstTurn: boolean;
  readonly ref: ThreadRef;
  readonly text: string;
}) {
  const pane = paneOf(input.ref);

  // Something true before the agent has said anything, so the pane is never
  // blank while a run is live. Replaced by the agent's own words as they land.
  yield* input.assistant.setStatus(pane, "is thinking…", ["is thinking…"]);

  // Only on the FIRST turn: the title names the whole conversation in the
  // reader's assistant history, so re-titling it from every later message would
  // keep renaming a thread after whatever it was actually about.
  if (input.firstTurn) {
    yield* input.assistant.setTitle(pane, titleFromMessage(input.text));
  }

  return yield* input.assistant.contextFor(keyOf(pane));
});
