/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */

import { Context, Effect } from "effect";

import type { Question } from "../helpers/blockers/questions.ts";
import type { ThreadRef } from "../thread/thread.ts";

export interface PendingForm {
  readonly askId: string;
  readonly intro: string;
  readonly messageTs: string | undefined;
  readonly questions: readonly Question[];
  readonly ref: ThreadRef;
}

export interface QuestionnairesShape {
  readonly clear: (askId: string) => Effect.Effect<void>;
  readonly get: (askId: string) => Effect.Effect<PendingForm | undefined>;
  readonly pending: () => Effect.Effect<number>;
  readonly put: (form: PendingForm) => Effect.Effect<void>;
}

export class Questionnaires extends Context.Service<
  Questionnaires,
  QuestionnairesShape
>()("ori/slack/Questionnaires") {}

const MAX_PENDING = 200;

export const QuestionnairesMemory = Effect.sync(() => {
  const forms = new Map<string, PendingForm>();

  return Questionnaires.of({
    clear: (askId) =>
      Effect.sync(() => {
        forms.delete(askId);
      }).pipe(Effect.withSpan("Slack.interactions.clear")),

    get: (askId) =>
      Effect.sync(() => forms.get(askId)).pipe(
        Effect.withSpan("Slack.interactions.get")
      ),

    pending: () =>
      Effect.sync(() => forms.size).pipe(
        Effect.withSpan("Slack.interactions.pending")
      ),

    put: (form) =>
      Effect.sync(() => {
        forms.set(form.askId, form);
        while (forms.size > MAX_PENDING) {
          const oldest = forms.keys().next();
          if (oldest.done === true) {
            break;
          }
          forms.delete(oldest.value);
        }
      }).pipe(Effect.withSpan("Slack.interactions.put")),
  });
});
