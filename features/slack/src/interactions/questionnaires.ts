/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * questionnaires.ts — forms waiting to be answered.
 *
 * A blocker holds the RUN open until someone answers. A questionnaire does
 * the opposite: the turn posts its questions and ENDS, and the answers arrive
 * later as a new turn on the same thread, which resumes the same session. So
 * nothing is held — not the thread's queue, not a session, not an HTTP
 * response — and a form left unanswered over a weekend costs nothing.
 *
 * That is why this outlives the turn that created it, and therefore cannot
 * live on the turn. A SERVICE for the same reason as `ThreadContext` and
 * `Blockers`: a downstream feature can wrap it — answer from a web UI, chase
 * an unanswered form, mirror it into Linear — rather than forking the surface.
 *
 * In memory, so a restart forgets pending forms. The reader still has the
 * message and can say the answer in the thread instead, which is the same
 * recovery as any other interrupted conversation.
 */

import { Context, Effect } from "effect";

import type { Question } from "../helpers/blockers/questions.ts";
import type { ThreadRef } from "../thread/thread.ts";

/** A form that has been posted and is waiting on someone. */
export interface PendingForm {
  readonly askId: string;
  readonly intro: string;
  /** The message carrying the button, so it can be retired on submit. */
  readonly messageTs: string | undefined;
  readonly questions: readonly Question[];
  readonly ref: ThreadRef;
}

export interface QuestionnairesShape {
  /** Forget a form. Called once its answers have started a turn. */
  readonly clear: (askId: string) => Effect.Effect<void>;
  /** The form behind an ask id, or undefined once it is gone. */
  readonly get: (askId: string) => Effect.Effect<PendingForm | undefined>;
  /** Forms still waiting. Pins that a submitted form is cleaned up. */
  readonly pending: () => Effect.Effect<number>;
  readonly put: (form: PendingForm) => Effect.Effect<void>;
}

export class Questionnaires extends Context.Service<
  Questionnaires,
  QuestionnairesShape
>()("ori/slack/Questionnaires") {}

/**
 * How many forms one process keeps.
 *
 * Bounded because nothing expires them: a form nobody answers is never cleared,
 * and an unbounded map of those is a leak that only shows up after weeks.
 */
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
