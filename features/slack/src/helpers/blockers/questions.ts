/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * questions.ts — several questions in one form, answered in one submission.
 *
 * `slack-ask` asks ONE question and blocks the run until it is answered. That
 * shape does not scale to the case it keeps meeting: a run with three branching
 * decisions in front of it either posts three messages and blocks three times,
 * or guesses. Devin batches them, and the reason it can is that a modal returns
 * every field at once.
 *
 * Two surfaces, in the only order Slack allows. The MESSAGE carries the button;
 * a bot cannot open a modal on its own, because `views.open` needs a
 * `trigger_id` that only an interaction mints. The MODAL carries the questions.
 *
 * The ask id rides in the callback id, because a `view_submission` payload
 * carries no button value and nothing else survives the round trip.
 */

import { Schema } from "effect";

import type { SlackBlock } from "../block-kit/blocks.ts";
import type { ModalView } from "../modals/modals.ts";

import {
  actions,
  button,
  choiceInput,
  inputBlock,
  section,
} from "../block-kit/blocks.ts";
import { asMrkdwn } from "../block-kit/mrkdwn.ts";

export const QUESTIONS_ACTION_ID = "ori_questions_open";
export const QUESTIONS_MODAL_CALLBACK = "ori_questions_form";

/** Separator that cannot appear in an ask id. */
const FIELD_SEPARATOR = "|";

/** Slack caps a modal at 100 blocks; each question costs one, plus the intro. */
const MAX_QUESTIONS = 20;

/**
 * How a question is answered.
 *
 * `text` is always available as a fallback, because a fixed set of choices is a
 * guess about what the reader wants to say and being wrong about that is what
 * makes a form worse than a plain question.
 */
export const QuestionKind = Schema.Literals(["single", "multi", "text"]);

export const QuestionSchema = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  kind: Schema.optionalKey(QuestionKind),
  choices: Schema.optionalKey(Schema.Array(Schema.String)),
  optional: Schema.optionalKey(Schema.Boolean),
});
export type Question = typeof QuestionSchema.Type;

export const QuestionsSchema = Schema.Array(QuestionSchema);

/** Block ids are how `state.values` keys an answer, so they carry the id. */
export const blockIdFor = (questionId: string): string =>
  `ori_q${FIELD_SEPARATOR}${questionId}`;

/**
 * Split on the FIRST separator only, because the id after it is the model's.
 *
 * Splitting on every one truncated `scope|deep` to `scope`, so the lookup in
 * `questions-handler.ts` missed, the answers list came back empty, and no turn
 * was ever started — the person typed an answer, hit Send, and the run died
 * silently believing nobody had replied.
 */
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

/** Which element a question becomes. Choices with no kind are single-select. */
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

/**
 * The message that opens the form.
 *
 * It names how many questions there are, because a button that only says
 * "Answer" gives a reader no idea whether this costs them ten seconds or two
 * minutes — and one they postpone is one the run waits on.
 */
export const questionsBlocks = (input: {
  readonly askId: string;
  readonly count: number;
  readonly intro: string;
}): readonly SlackBlock[] => [
  section(asMrkdwn(input.intro)),
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

/** What the message becomes once submitted — the button gone, answers shown. */
export const questionsAnsweredBlocks = (
  intro: string,
  answers: readonly { readonly prompt: string; readonly answer: string }[]
): readonly SlackBlock[] => [
  section(
    [
      asMrkdwn(intro),
      ...answers.map((entry) => `*${entry.prompt}*\n${asMrkdwn(entry.answer)}`),
    ].join("\n\n")
  ),
];

export const questionsModal = (input: {
  readonly askId: string;
  readonly intro: string;
  readonly questions: readonly Question[];
}): ModalView => ({
  blocks: [
    section(asMrkdwn(input.intro)),
    ...input.questions.slice(0, MAX_QUESTIONS).map(blockFor),
  ],
  callbackId: callbackFor(input.askId),
  closeLabel: "Cancel",
  submitLabel: "Send",
  title: "A few questions",
});
