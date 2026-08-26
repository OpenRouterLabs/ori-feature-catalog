/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * settle.ts — how a turn ends.
 *
 * A turn answers ONCE, with a real message. `section(answer)` over
 * `context(work log)` over `context(harness · model · tools)`, so the record
 * of what it did rides under the answer instead of dying with a progress
 * message.
 */

import { Effect } from "effect";

import type { SlackBlock } from "../helpers/block-kit/blocks.ts";
import type { MessageReplyShape } from "../message-reply/reply.ts";
import type { RunState } from "./run-state.ts";

import { context, markdown } from "../helpers/block-kit/blocks.ts";
import { RunPhase, minutesSince, renderRunState } from "./run-state.ts";

/**
 * A steered turn is superseded, not finished: its replacement carries the
 * work, and a message saying it stopped is a line about the surface.
 *
 * Only while a replacement actually exists. Without that check a steer with
 * no successor answered with NOTHING — the status line came up, went down,
 * and the thread was left with no reply and no way to tell it from a crash.
 */
const SUPERSEDED: ReadonlySet<RunPhase> = new Set([RunPhase.Steered]);

const answerOf = (state: RunState): string =>
  renderRunState(state, {
    withModel: false,
    withWorkLog: false,
  });

/**
 * Harness first: it says WHAT ran the turn, the model what it ran on.
 *
 * No tool counts. "bash ×23" is a fact about the machinery, not about the
 * answer — nobody reading a reply wants to know how many times a shell ran,
 * and it sat under every message like a receipt nobody asked for.
 */
/**
 * Whole minutes, never a decimal: this is a reply-time receipt, and "2.4m"
 * invites a precision the number does not have. Under a minute reads as
 * `<1m` rather than `0m`, which looks like the timer failed to start.
 */
const respondedIn = (state: RunState, now: number): string => {
  const minutes = minutesSince(state.startedAt, now);
  return minutes === 0 ? "<1m" : `${minutes}m`;
};

const smallPrint = (state: RunState, now: number): string =>
  [state.harness ?? "", state.model ?? "", respondedIn(state, now)]
    .filter((part) => part !== "")
    .join(" · ");

/**
 * The answer as a `markdown` block, with a line of small print under it.
 *
 * A `markdown` block, NOT a `section` and not `markdown_text`. Three dialects,
 * and only this one renders TABLES and lists — Slack added them to Block Kit
 * in March 2026. A `section` is Slack's own `mrkdwn`, which has neither and
 * prints `**like this**` literally; `markdown_text` on `chat.postMessage` is
 * different again and carries no tables.
 *
 * The narration does NOT come along. Those lines are mid-work thoughts — "Let
 * me confirm what upstream lacks", "Let me check version drift" — and under a
 * finished answer they read as a reply that stopped half way. They had their
 * moment in the status line while the work was happening.
 */
const answerBlocks = (state: RunState, now: number): readonly SlackBlock[] => {
  const small = smallPrint(state, now);
  return [markdown(answerOf(state)), ...(small === "" ? [] : [context(small)])];
};

export const settle = (input: {
  readonly reply: MessageReplyShape;
  readonly state: RunState;
  /** True when another turn is queued to answer in this one's place. */
  readonly superseded: boolean;
  /** Injectable for tests; the wall clock otherwise. */
  readonly now?: number | undefined;
}): Effect.Effect<void> => {
  const { reply, state } = input;
  const now = input.now ?? Date.now();
  if (SUPERSEDED.has(state.phase) && input.superseded) {
    return Effect.void;
  }
  // Posted, never edited into an earlier message. Every shape that reused one
  // message needed a timestamp to survive the whole run, a fallback for when
  // Slack had moved on from it, and a rule for what the message meant in the
  // meantime. A thread is a log: the answer is the last thing in it.
  //
  // Blocks, so the answer can be a `markdown` block — the only place Slack
  // renders tables and lists — while `replyBlocks` still carries plain
  // fallback text for the notification.
  return reply.replyBlocks(answerBlocks(state, now), answerOf(state)).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("[slack] could not post the answer", cause)
    ),
    Effect.asVoid
  );
};
