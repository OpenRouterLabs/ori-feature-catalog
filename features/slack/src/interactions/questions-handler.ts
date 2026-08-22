/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * questions-handler.ts — a click opens the form, a submit starts the next turn.
 *
 * The click is the only moment a modal can be opened at all: `views.open`
 * needs a `trigger_id`, an interaction is the only thing that mints one, and it
 * expires three seconds later. So nothing is awaited between the click landing
 * and the modal opening.
 *
 * The submit is where this differs from a blocker. Nothing is waiting on the
 * answers — the turn that asked has long since ended — so they start a NEW
 * turn on the same thread. That thread maps to the same session, so the model
 * picks up with everything it knew, plus the answers.
 */

import { Effect } from "effect";

import type { SlackClientShape } from "../client/client.ts";
import type { InteractionsShape } from "./interactions.ts";
import type { PendingForm, QuestionnairesShape } from "./questionnaires.ts";

import {
  askIdFromQuestionsCallback,
  QUESTIONS_ACTION_ID,
  QUESTIONS_MODAL_CALLBACK,
  questionIdFromBlock,
  questionsAnsweredBlocks,
  questionsModal,
} from "../helpers/blockers/questions.ts";
import { openModal } from "../helpers/modals/modals.ts";

/** One answered question, in the order it was asked. */
interface Answered {
  readonly answer: string;
  readonly prompt: string;
}

/**
 * The answers, in the order the questions were ASKED.
 *
 * Slack returns `state.values` keyed by block id with no guaranteed order, and
 * a list of answers whose order drifts from the questions is worse than no
 * list — the reader and the model are then looking at different documents.
 */
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

/**
 * What the next turn reads.
 *
 * Fenced and labelled, because this is text a person typed and it lands in a
 * prompt: it is data the model should act on, not instructions it should obey.
 */
export const answersPrompt = (answers: readonly Answered[]): string =>
  [
    "<answers>",
    ...answers.map((entry) => `${entry.prompt}\n${entry.answer}`),
    "</answers>",
    "These are the answers to the questions you asked. Carry on from where you",
    "stopped.",
  ].join("\n");

interface HandlerDeps {
  readonly continueTurn: (form: PendingForm, prompt: string) => void;
  readonly forms: QuestionnairesShape;
  readonly interactions: InteractionsShape;
  readonly slack: SlackClientShape;
}

/** The click that mints the trigger the modal cannot be opened without. */
const onOpenClicked = (input: HandlerDeps): void => {
  input.interactions.on(QUESTIONS_ACTION_ID, (payload) =>
    Effect.gen(function* () {
      const askId = payload.actions[0]?.value;
      if (askId === undefined || payload.triggerId === undefined) {
        yield* Effect.logWarning(
          "[slack] a questions button arrived with no ask id or trigger"
        );
        return;
      }
      const form = yield* input.forms.get(askId);
      if (form === undefined) {
        // The daemon restarted, or the form was already answered. Saying
        // nothing is right: the thread still holds the questions, and someone
        // can answer them in words.
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

/** The submit that starts the next turn. */
const onSubmitted = (input: HandlerDeps): void => {
  input.interactions.onView(QUESTIONS_MODAL_CALLBACK, (payload) =>
    Effect.gen(function* () {
      const askId = askIdFromQuestionsCallback(payload.callbackId);
      if (askId === undefined) {
        return;
      }
      const form = yield* input.forms.get(askId);
      if (form === undefined) {
        yield* Effect.logWarning("[slack] a form was submitted twice, or late");
        return;
      }
      // Cleared BEFORE the turn starts: a second submission of the same form
      // would otherwise start a second turn on the same thread, and the first
      // thing that turn does is steer the one already running.
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
        // Submitted with everything optional left blank. Starting a turn to
        // say nothing is worse than letting the thread sit.
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
