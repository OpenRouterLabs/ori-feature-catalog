import { Context, Effect, Schema } from "effect";

import { QuestionsSchema } from "#src/helpers/blockers/questions.ts";
import { ThreadRefSchema } from "#src/thread/thread.ts";

const PendingFormSchema = Schema.Struct({
  askId: Schema.String,
  intro: Schema.String,
  messageTs: Schema.UndefinedOr(Schema.String),
  questions: QuestionsSchema,
  ref: ThreadRefSchema,
});

export type PendingForm = typeof PendingFormSchema.Type;

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
