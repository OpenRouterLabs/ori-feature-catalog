/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * blockers.ts — the message a blocking question puts in the thread.
 *
 * One section with the question, and one button per choice. The buttons are
 * the only way to answer: the modal that used to offer a typed answer is gone,
 * and a reader who wants something unlisted @-mentions the bot instead.
 */

import type { SlackBlock } from "../block-kit/blocks.ts";

import { actions, button, section } from "../block-kit/blocks.ts";

export const BLOCKER_ACTION_ID = "ori_blocker_choice";

/** Separator between the ask id and the choice id; the choice id may contain it. */
const FIELD_SEPARATOR = "|";

/** A choice offered to the reader. `id` comes back to the agent verbatim. */
interface BlockerChoice {
  readonly id: string;
  readonly label: string;
}

export const encodeChoice = (askId: string, choiceId: string): string =>
  [askId, choiceId].join(FIELD_SEPARATOR);

/**
 * Split on the FIRST separator only: everything after it is the agent's own
 * choice id, verbatim.
 *
 * Splitting on every one truncated `rebase|force` to `rebase`, so two distinct
 * choices answered as the same one and `answer=$(slack-ask …)` branched into
 * the wrong arm with nothing reporting an error.
 */
export const decodeChoice = (
  value: string | undefined
): { readonly askId: string; readonly choiceId: string } | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const at = value.indexOf(FIELD_SEPARATOR);
  if (at <= 0) {
    return undefined;
  }
  return {
    askId: value.slice(0, at),
    choiceId: value.slice(at + FIELD_SEPARATOR.length),
  };
};

/**
 * The blocker message: the question, and a button per choice.
 *
 * There is no "Something else…" button. It opened a modal, and a modal is a
 * second way of typing into a thread that already accepts typing — a reader
 * with an answer nobody offered can say so in the thread, which reaches the
 * agent as a message like any other. The modal cost a `trigger_id` that
 * expires in three seconds, a `view_submission` round trip, and a copy of the
 * question held in memory purely so the form could repeat it back.
 */
export const blockerBlocks = (input: {
  readonly askId: string;
  readonly choices: readonly BlockerChoice[];
  readonly question: string;
}): readonly SlackBlock[] => [
  section(`**Blocked**\n${input.question}`),
  actions(
    input.choices.map((choice) =>
      button({
        actionId: BLOCKER_ACTION_ID,
        label: choice.label,
        value: encodeChoice(input.askId, choice.id),
      })
    )
  ),
];

/** What the message becomes once answered — buttons gone. */
export const blockerAnsweredBlocks = (
  question: string,
  answer: string
): readonly SlackBlock[] => [section(`**Blocked** — ${question}\n_${answer}_`)];
