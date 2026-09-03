import { Effect, Schema } from "effect";

import type {
  InteractionPayload,
  ViewSubmissionPayload,
} from "./interactions.ts";
import type { PendingForm } from "./questionnaires.ts";

import { SlackClientShapeSchema } from "#src/client/client.ts";
import { functionSchema } from "#src/schema-support.ts";
import { InteractionsShapeSchema } from "./interactions.ts";
import { QuestionnairesShapeSchema } from "./questionnaires.ts";

import {
  askIdFromQuestionsCallback,
  QUESTIONS_ACTION_ID,
  QUESTIONS_MODAL_CALLBACK,
  questionIdFromBlock,
  questionsAnsweredBlocks,
  questionsModal,
} from "#src/helpers/blockers/questions.ts";
import { openModal } from "#src/helpers/modals/index.ts";

const AnsweredSchema = Schema.Struct({
  answer: Schema.String,
  prompt: Schema.String,
});

type Answered = typeof AnsweredSchema.Type;

const answersOf = (
  form: PendingForm,
  values: ReadonlyMap<string, string>
): readonly Answered[] => {
  const byQuestion = new Map<string, string>();
  for (const [blockId, answer] of values) {
    const questionId = questionIdFromBlock(blockId);
    if (questionId !== undefined && answer.trim() !== "") {
      byQuestion.set(questionId, answer.trim());
    }
  }
  return form.questions.flatMap((question) => {
    const answer = byQuestion.get(question.id);
    return answer === undefined
      ? []
      : [
          {
            answer,
            prompt: question.prompt,
          },
        ];
  });
};

export const answersPrompt = (answers: readonly Answered[]): string =>
  [
    "<answers>",
    ...answers.map((entry) => `${entry.prompt}\n${entry.answer}`),
    "</answers>",
    "These are the answers to the questions you asked. Carry on from where you",
    "stopped.",
  ].join("\n");

const HandlerDepsSchema = Schema.Struct({
  continueTurn:
    functionSchema<(form: PendingForm, prompt: string) => void>(
      "HandlerDeps.continueTurn"
    ),
  forms: QuestionnairesShapeSchema,
  interactions: InteractionsShapeSchema,
  slack: SlackClientShapeSchema,
});

type HandlerDeps = typeof HandlerDepsSchema.Type;

const onOpenClicked = (input: HandlerDeps): void => {
  input.interactions.on(
    QUESTIONS_ACTION_ID,
    Effect.fn("Slack.interactions.openQuestionsForm")(function* (
      payload: InteractionPayload
    ) {
      const askId = payload.actions[0]?.value;
      if (askId === undefined || payload.triggerId === undefined) {
        yield* Effect.logWarning(
          "[slack] a questions button arrived with no ask id or trigger"
        );
        return;
      }
      const form = yield* input.forms.get(askId);
      if (form === undefined) {
        yield* Effect.logWarning("[slack] no pending form for that button");
        return;
      }
      yield* openModal(input.slack, {
        triggerId: payload.triggerId,
        view: questionsModal({
          askId,
          intro: form.intro,
          questions: form.questions,
        }),
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("[slack] could not open the questions form", cause)
        )
      );
    })
  );
};

const onSubmitted = (input: HandlerDeps): void => {
  input.interactions.onView(
    QUESTIONS_MODAL_CALLBACK,
    Effect.fn("Slack.interactions.submitQuestionsForm")(function* (
      payload: ViewSubmissionPayload
    ) {
      const askId = askIdFromQuestionsCallback(payload.callbackId);
      if (askId === undefined) {
        return;
      }
      const form = yield* input.forms.get(askId);
      if (form === undefined) {
        yield* Effect.logWarning("[slack] a form was submitted twice, or late");
        return;
      }
      yield* input.forms.clear(askId);

      const answers = answersOf(form, payload.values);
      if (form.messageTs !== undefined) {
        yield* input.slack
          .updateMessage({
            blocks: [...questionsAnsweredBlocks(form.intro, answers)],
            channel: form.ref.channelId,
            text: form.intro,
            ts: form.messageTs,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "[slack] could not retire the questions message",
                cause
              )
            )
          );
      }

      if (answers.length === 0) {
        return;
      }
      yield* Effect.sync(() => {
        input.continueTurn(form, answersPrompt(answers));
      });
    })
  );
};

export const registerQuestionHandlers = (input: HandlerDeps): void => {
  onOpenClicked(input);
  onSubmitted(input);
};
