import { type SlackBlock, actions, button, section } from "#src/helpers/block-kit/blocks.ts";

import { Schema } from "effect";


export const BLOCKER_ACTION_ID = "ori_blocker_choice";

const FIELD_SEPARATOR = "|";

const BlockerChoiceSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});

type BlockerChoice = typeof BlockerChoiceSchema.Type;

export const encodeChoice = (askId: string, choiceId: string): string =>
  [askId, choiceId].join(FIELD_SEPARATOR);

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

export const blockerBlocks = (input: {
  readonly askId: string;
  readonly choices: readonly BlockerChoice[];
  readonly question: string;
}): readonly SlackBlock[] => [
  section(`**Blocked**\n${input.question}`),
  actions(
    input.choices.map((choice, index) =>
      button({
        actionId: `${BLOCKER_ACTION_ID}${FIELD_SEPARATOR}${index}`,
        label: choice.label,
        value: encodeChoice(input.askId, choice.id),
      })
    )
  ),
];

export const blockerAnsweredBlocks = (
  question: string,
  answer: string
): readonly SlackBlock[] => [section(`**Blocked** — ${question}\n_${answer}_`)];
