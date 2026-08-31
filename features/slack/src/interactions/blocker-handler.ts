/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */

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
