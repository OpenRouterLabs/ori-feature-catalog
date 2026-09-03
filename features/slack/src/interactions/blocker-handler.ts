import { Effect } from "effect";

import type { BlockersShape } from "./blocker.ts";
import type {
  InteractionPayload,
  InteractionsShape,
} from "./interactions.ts";

import {
  BLOCKER_ACTION_ID,
  decodeChoice,
} from "#src/helpers/blockers/index.ts";

export const registerBlockerHandlers = (input: {
  readonly blockers: BlockersShape;
  readonly interactions: InteractionsShape;
}): void => {
  input.interactions.onPrefix(
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
