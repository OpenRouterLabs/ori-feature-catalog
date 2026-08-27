/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * questions-route.ts — the loopback route behind the `slack-questions` skill.
 *
 * It posts and RETURNS. Unlike the blocker route, which holds the HTTP
 * response until someone answers, this one hands back an ask id immediately so
 * the model can finish its turn. The answers come back later as a new turn on
 * the same thread, which resumes the same session.
 *
 * That is the whole point: a question no longer costs a held run. A form left
 * over a weekend costs nothing, and the thread's queue is free the moment the
 * turn ends.
 *
 * HTTP is the one edge, so Effect is entered once per request: the liveness
 * check, the post and the store all run in that single fiber.
 */

import { Effect, Result, Schema } from "effect";

import type { QuestionnairesShape } from "../../interactions/questionnaires.ts";
import type { ThreadRef } from "../../thread/thread.ts";
import type { Refusal } from "./loopback-route.ts";

import {
  QuestionsSchema,
  questionsBlocks,
} from "../../helpers/blockers/questions.ts";
import { loopbackRoute, refuse, threadFields } from "./loopback-route.ts";

const HTTP_BAD_GATEWAY = 502;
const HTTP_NOT_FOUND = 404;

/** Enough to batch the decisions in front of a run, few enough to answer. */
const MAX_QUESTIONS = 10;

const AskBody = Schema.Struct({
  ...threadFields,
  intro: Schema.String,
  questions: QuestionsSchema,
});
const decodeBody = Schema.decodeUnknownResult(AskBody);

export interface AskRequest {
  readonly channel: string;
  readonly intro: string;
  readonly questions: typeof QuestionsSchema.Type;
  readonly team: string | undefined;
  readonly threadTs: string;
}

export type AskParse =
  | { readonly ok: true; readonly request: AskRequest }
  | { readonly ok: false; readonly error: string };

export const parseAskBody = (raw: unknown): AskParse =>
  Result.match(decodeBody(raw), {
    onFailure: (): AskParse => ({
      error:
        "expected { channel, thread_ts, intro, questions: [{ id, prompt, kind?, choices?, optional? }] }",
      ok: false,
    }),
    onSuccess: (decoded): AskParse => {
      if (decoded.questions.length === 0) {
        return {
          error: "ask at least one question",
          ok: false,
        };
      }
      if (decoded.questions.length > MAX_QUESTIONS) {
        return {
          error: `${decoded.questions.length} questions is more than anyone will answer (max ${MAX_QUESTIONS})`,
          ok: false,
        };
      }
      const ids = new Set(decoded.questions.map((question) => question.id));
      if (ids.size !== decoded.questions.length) {
        // The id is how an answer finds its question on the way back, so a
        // duplicate silently drops one of them.
        return {
          error: "every question needs its own id",
          ok: false,
        };
      }
      return {
        ok: true,
        request: {
          channel: decoded.channel,
          intro: decoded.intro.trim(),
          questions: decoded.questions,
          team: decoded.team,
          threadTs: decoded.thread_ts,
        },
      };
    },
  });

interface QuestionsRouteDeps {
  readonly forms: QuestionnairesShape;
  readonly newAskId: () => string;
  readonly post: (
    ref: ThreadRef,
    blocks: readonly unknown[],
    fallback: string
  ) => Promise<string | undefined>;
  /** False when no turn is running in that thread — the shell derives the ref. */
  readonly isLive: (ref: ThreadRef) => Promise<boolean>;
  /** The team a body that omits one belongs to. */
  readonly workspaceTeamId: string;
}

/** Post the form, then record it under the id the answer will carry back. */
const askQuestions = Effect.fn("Slack.questions.ask")(function* (input: {
  readonly deps: QuestionsRouteDeps;
  readonly ref: ThreadRef;
  readonly request: AskRequest;
}): Effect.fn.Return<Result.Result<{ readonly ask_id: string }, Refusal>> {
  const live = yield* Effect.promise(() => input.deps.isLive(input.ref));
  if (!live) {
    // A form with no run behind it is dead mail: nothing will be started
    // again when it is answered.
    return refuse(HTTP_NOT_FOUND, "no run is active in that thread");
  }

  const askId = input.deps.newAskId();
  const messageTs = yield* Effect.promise(() =>
    input.deps.post(
      input.ref,
      questionsBlocks({
        askId,
        count: input.request.questions.length,
        intro: input.request.intro,
      }),
      input.request.intro
    )
  );

  if (messageTs === undefined) {
    // Nothing is on screen, so nothing can ever answer it. Reporting an
    // ask here is worse than failing: the skill tells the model to END ITS
    // TURN and wait to be started again with the answers, and no message,
    // no button and no `view_submission` will ever exist to do that.
    return refuse(HTTP_BAD_GATEWAY, "the questions could not be posted");
  }

  yield* input.deps.forms.put({
    askId,
    intro: input.request.intro,
    messageTs,
    questions: input.request.questions,
    ref: input.ref,
  });

  return Result.succeed({ ask_id: askId });
});

export const makeQuestionsRoute = (
  deps: QuestionsRouteDeps
): ((request: Request) => Promise<Response>) =>
  loopbackRoute<AskRequest, { readonly ask_id: string }>({
    // Ten questions with their choices; anything larger is not a form.
    capKiB: 32,
    handle: async ({ ref, request }) =>
      // The one boundary the route owns: HTTP is a Promise, the work is not.
      Effect.runPromise(
        askQuestions({
          deps,
          ref,
          request,
        })
      ),
    parse: (raw): Result.Result<AskRequest, string> => {
      const parsed = parseAskBody(raw);
      return parsed.ok
        ? Result.succeed(parsed.request)
        : Result.fail(parsed.error);
    },
    workspaceTeamId: deps.workspaceTeamId,
  });
