/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * retire-turn.ts — what every turn must leave behind, however it ends.
 *
 * The indicator goes out, and every blocker the turn opened is settled.
 *
 * A blocker outlives its turn otherwise: the ask lives in a service, not on
 * the turn, so a cancelled or steered run left a live button that told whoever
 * clicked it their answer had been accepted — by a run that ended long before.
 * `slack-ask` reads the settled promise as "unanswered" and the agent decides
 * for itself, which is what it does on a timeout anyway.
 *
 * Its own module because it runs as an `Effect.ensuring` finalizer, and what
 * belongs in one is a decision worth being able to find.
 */

import { Effect } from "effect";

import type { BlockersShape } from "../interactions/blocker.ts";
import type { AssistantThreadsShape } from "../thread/assistant.ts";
import type { ThreadRef } from "../thread/thread.ts";

import { paneOf } from "./context/pane-context.ts";

/** Why a waiting ask is being settled without an answer. */
const RUN_ENDED = "the run ended before this was answered";

/**
 * Safe as a finalizer because neither call fails: both are best-effort and
 * log, so a Slack blip here cannot mask the error that ended the turn.
 */
export const retireTurn = (input: {
  readonly assistant: AssistantThreadsShape;
  readonly blockers: BlockersShape;
  readonly instanceId: string;
  readonly ref: ThreadRef;
}): Effect.Effect<void> =>
  input.assistant
    .setStatus(paneOf(input.ref), "")
    .pipe(
      Effect.andThen(input.blockers.abandonThread(input.instanceId, RUN_ENDED)),
      Effect.withSpan("Slack.turn.retire")
    );
