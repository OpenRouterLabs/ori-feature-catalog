import { Effect, Result, Schema } from "effect";

import type { QuestionnairesShape } from "#src/interactions/questionnaires.ts";
import type { ThreadRef } from "#src/thread/index.ts";
import { type Refusal, loopbackRoute, refuse, threadFields } from "./loopback-route.ts";

import {
  QuestionsSchema,
  questionsBlocks,
} from "#src/helpers/blockers/questions.ts";
import { functionSchema, opaqueSchema } from "#src/schema-support.ts";

const HTTP_BAD_GATEWAY = 502;
const HTTP_NOT_FOUND = 404;

const MAX_QUESTIONS = 10;

const AskBody = Schema.Struct({
  ...threadFields,
  intro: Schema.String,
  questions: QuestionsSchema,
});
const decodeBody = Schema.decodeUnknownResult(AskBody);

export const AskRequestSchema = Schema.Struct({
  channel: Schema.String,
  intro: Schema.String,
  questions: QuestionsSchema,
  team: Schema.UndefinedOr(Schema.String),
  threadTs: Schema.String,
});

export type AskRequest = typeof AskRequestSchema.Type;

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

const QuestionsRouteDepsSchema = Schema.Struct({
  forms: opaqueSchema<QuestionnairesShape>("QuestionsRouteDeps.forms"),
  newAskId: functionSchema<() => string>("QuestionsRouteDeps.newAskId"),
  post: functionSchema<
    (
      ref: ThreadRef,
      blocks: readonly unknown[],
      fallback: string
    ) => Promise<string | undefined>
  >("QuestionsRouteDeps.post"),
  isLive: functionSchema<(ref: ThreadRef) => Promise<boolean>>(
    "QuestionsRouteDeps.isLive"
  ),
  workspaceTeamId: Schema.String,
});

type QuestionsRouteDeps = typeof QuestionsRouteDepsSchema.Type;

const askQuestions = Effect.fn("Slack.questions.ask")(function* (input: {
  readonly deps: QuestionsRouteDeps;
  readonly ref: ThreadRef;
  readonly request: AskRequest;
}): Effect.fn.Return<Result.Result<{ readonly ask_id: string }, Refusal>> {
  const live = yield* Effect.promise(() => input.deps.isLive(input.ref));
  if (!live) {
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
    capKiB: 32,
    handle: ({ ref, request }) =>
      askQuestions({
        deps,
        ref,
        request,
      }),
    parse: (raw): Result.Result<AskRequest, string> => {
      const parsed = parseAskBody(raw);
      return parsed.ok
        ? Result.succeed(parsed.request)
        : Result.fail(parsed.error);
    },
    workspaceTeamId: deps.workspaceTeamId,
  });
