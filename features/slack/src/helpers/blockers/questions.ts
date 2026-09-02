import { Schema } from "effect";

import { actions, button, choiceInput, inputBlock, section, type SlackBlock } from "#src/helpers/block-kit/blocks.ts";
import type { ModalView } from "#src/helpers/modals/modals.ts";


export const QUESTIONS_ACTION_ID = "ori_questions_open";
export const QUESTIONS_MODAL_CALLBACK = "ori_questions_form";

const FIELD_SEPARATOR = "|";

const MAX_QUESTIONS = 20;

const QuestionKind = Schema.Literals(["single", "multi", "text"]);

const QuestionSchema = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  kind: Schema.optionalKey(QuestionKind),
  choices: Schema.optionalKey(Schema.Array(Schema.String)),
  optional: Schema.optionalKey(Schema.Boolean),
});
export type Question = typeof QuestionSchema.Type;

export const QuestionsSchema = Schema.Array(QuestionSchema);

export const blockIdFor = (questionId: string): string =>
  `ori_q${FIELD_SEPARATOR}${questionId}`;

export const questionIdFromBlock = (blockId: string): string | undefined => {
  const at = blockId.indexOf(FIELD_SEPARATOR);
  if (at === -1 || blockId.slice(0, at) !== "ori_q") {
    return undefined;
  }
  const id = blockId.slice(at + FIELD_SEPARATOR.length);
  return id === "" ? undefined : id;
};

export const callbackFor = (askId: string): string =>
  `${QUESTIONS_MODAL_CALLBACK}${FIELD_SEPARATOR}${askId}`;

export const askIdFromQuestionsCallback = (
  callbackId: string
): string | undefined => {
  const [prefix, askId] = callbackId.split(FIELD_SEPARATOR);
  return prefix === QUESTIONS_MODAL_CALLBACK &&
    askId !== undefined &&
    askId !== ""
    ? askId
    : undefined;
};

const kindOf = (question: Question): "single" | "multi" | "text" => {
  if (question.kind !== undefined) {
    return question.kind;
  }
  return (question.choices ?? []).length > 0 ? "single" : "text";
};

const blockFor = (question: Question): SlackBlock => {
  const kind = kindOf(question);
  const choices = question.choices ?? [];
  if (kind === "text" || choices.length === 0) {
    return inputBlock({
      actionId: "answer",
      blockId: blockIdFor(question.id),
      label: question.prompt,
      multiline: true,
      ...(question.optional === undefined
        ? {}
        : { optional: question.optional }),
    });
  }
  return choiceInput({
    actionId: "answer",
    blockId: blockIdFor(question.id),
    choices: choices.map((choice) => ({
      label: choice,
      value: choice,
    })),
    label: question.prompt,
    multi: kind === "multi",
    ...(question.optional === undefined ? {} : { optional: question.optional }),
  });
};

export const questionsBlocks = (input: {
  readonly askId: string;
  readonly count: number;
  readonly intro: string;
}): readonly SlackBlock[] => [
  section(input.intro),
  actions([
    button({
      actionId: QUESTIONS_ACTION_ID,
      label:
        input.count === 1
          ? "Answer 1 question"
          : `Answer ${input.count} questions`,
      value: input.askId,
    }),
  ]),
];

export const questionsAnsweredBlocks = (
  intro: string,
  answers: readonly { readonly prompt: string; readonly answer: string }[]
): readonly SlackBlock[] => [
  section(
    [
      intro,
      ...answers.map((entry) => `**${entry.prompt}**\n${entry.answer}`),
    ].join("\n\n")
  ),
];

export const questionsModal = (input: {
  readonly askId: string;
  readonly intro: string;
  readonly questions: readonly Question[];
}): ModalView => ({
  blocks: [
    section(input.intro),
    ...input.questions.slice(0, MAX_QUESTIONS).map(blockFor),
  ],
  callbackId: callbackFor(input.askId),
  closeLabel: "Cancel",
  submitLabel: "Send",
  title: "A few questions",
});
