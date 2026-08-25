/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * blocker-handler.ts — turning a click on a blocker into an answer.
 *
 * A click resolves the promise the turn is waiting on, and that is all it
 * does. It used to also mint a `trigger_id` and open a freeform modal for a
 * reader who wanted to say something not offered — three seconds to use the
 * trigger, a `view_submission` round trip, and the question held in memory so
 * the form could repeat it back. A thread already takes typing: someone with
 * an answer nobody listed says so in the thread, and it reaches the agent as a
 * message like any other.
 */

import { Effect } from "effect";

import type { BlockersShape } from "./blocker.ts";
import type {
  InteractionPayload,
  InteractionsShape,
} from "./interactions.ts";

import {
  BLOCKER_ACTION_ID,
  decodeChoice,
} from "../helpers/blockers/blockers.ts";

/** Wire the blocker buttons. */
export const registerBlockerHandlers = (input: {
  readonly blockers: BlockersShape;
  readonly interactions: InteractionsShape;
}): void => {
  input.interactions.on(
    BLOCKER_ACTION_ID,
    Effect.fn("Slack.interactions.answerBlocker")(function* (
      payload: InteractionPayload
    ) {
      const decoded = decodeChoice(payload.actions.at(0)?.value);
      if (decoded === undefined) {
        return;
      }
      yield* input.blockers.answer(decoded.askId, decoded.choiceId);
    })
  );
};
