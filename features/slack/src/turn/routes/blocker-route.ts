/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * blocker-route.ts — the loopback route behind the `slack-ask` skill.
 *
 * Unlike the status and chart routes this one does not return immediately: it
 * posts the question, then HOLDS the HTTP response until someone answers. That
 * is what makes the skill a blocking call, and what lets the agent write
 * `answer=$(slack-ask …)` and carry on with the reply in hand.
 *
 * The wait is bounded. An unanswered blocker must not pin a turn until its
 * deadline with nothing on screen explaining why, so it gives up, says so in
 * the thread, and tells the agent to decide for itself.
 */

import { Effect, Result, Schema } from "effect";

import { bestEffort } from "../../helpers/best-effort.ts";

import type { SlackBlock } from "../../helpers/block-kit/blocks.ts";
import type { BlockersShape } from "../../interactions/blocker.ts";
import type { MessageReplyShape } from "../../message-reply/reply.ts";
import type { ThreadRef } from "../../thread/index.ts";

import {
  blockerAnsweredBlocks,
  blockerBlocks,
} from "../../helpers/blockers/blockers.ts";
import { loopbackRoute, refuse, threadFields } from "./loopback-route.ts";

/** A question and at most five short labels; anything larger is not one. */
const MAX_ASK_BODY_KIB = 16;

/**
 * Slack renders at most five buttons in a row before they wrap badly.
 *
 * REJECTED, not truncated. Silently dropping the sixth choice meant an agent
 * that took the skill's advice — offer every option you can act on — lost one
 * without being told, and there is no longer an escape button behind which
 * that loss was survivable.
 */
const MAX_CHOICES = 5;

/** A question is a sentence, not a briefing. */
const MAX_QUESTION_CHARS = 500;

const HTTP_TIMEOUT = 408;
const HTTP_BAD_GATEWAY = 502;

/**
 * How long a blocker waits.
 *
 * Long enough to survive a meeting, short enough that a turn does not sit on
 * its whole deadline waiting for someone who has gone home. The agent is told
 * to decide for itself when this expires, which is better than either hanging
 * or silently guessing.
 */
const ASK_TIMEOUT_MINUTES = 15;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const DEFAULT_ASK_TIMEOUT_MS =
  ASK_TIMEOUT_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

const ChoiceBody = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});

const AskBody = Schema.Struct({
  ...threadFields,
  choices: Schema.optionalKey(Schema.UndefinedOr(Schema.Array(ChoiceBody))),
  question: Schema.String,
});
const decodeBody = Schema.decodeUnknownResult(AskBody);

export interface AskRequest {
  readonly channel: string;
  readonly choices: readonly { readonly id: string; readonly label: string }[];
  readonly question: string;
  readonly team: string | undefined;
  readonly threadTs: string;
}

export type AskParse =
  | { readonly ok: true; readonly request: AskRequest }
  | { readonly ok: false; readonly error: string };

/** Decode the wire body. Rejects rather than guessing at a malformed shape. */
export const parseAskBody = (raw: unknown): AskParse =>
  Result.match(decodeBody(raw), {
    onFailure: (): AskParse => ({
      error:
        "expected { channel, thread_ts, question, choices?: [{ id, label }], team? }",
      ok: false,
    }),
    onSuccess: (decoded): AskParse => {
      const question = decoded.question.trim();
      if (
        question === "" ||
        decoded.channel === "" ||
        decoded.thread_ts === ""
      ) {
        return {
          error: "channel, thread_ts and question must not be empty",
          ok: false,
        };
      }
      const choices = (decoded.choices ?? []).filter(
        (choice) => choice.id !== "" && choice.label !== ""
      );
      // A question with no buttons cannot be answered at all: the actions
      // block comes back empty, which Slack refuses to render. The freeform
      // escape used to fill this gap and no longer exists.
      if (choices.length === 0) {
        return {
          error:
            "a blocker needs at least one choice — the buttons are the only way to answer it",
          ok: false,
        };
      }
      if (choices.length > MAX_CHOICES) {
        return {
          error: `${choices.length} choices is more than Slack lays out in a row (max ${MAX_CHOICES}) — offer fewer, or ask a narrower question`,
          ok: false,
        };
      }
      return {
        ok: true,
        request: {
          channel: decoded.channel,
          choices,
          question: question.slice(0, MAX_QUESTION_CHARS),
          team: decoded.team,
          threadTs: decoded.thread_ts,
        },
      };
    },
  });

/** Named so the autofixer cannot strip a bare `undefined` and widen these. */
const NO_TS: string | undefined = undefined;
const NO_ANSWER: string | undefined = undefined;

interface AskOutcome {
  readonly timedOut: boolean;
  readonly value: string;
}

/** What the reader picked, in the words they saw rather than the id. */
const answerLabel = (request: AskRequest, value: string): string =>
  request.choices.find((choice) => choice.id === value)?.label ?? value;

/**
 * Rewrite the question once it is closed, whichever way it ended.
 *
 * Buttons on an answered question invite a second answer to something already
 * decided, and a timed-out one left live implies the run is still waiting.
 */
const retireQuestion = (input: {
  readonly answer: string | undefined;
  readonly reply: MessageReplyShape;
  readonly request: AskRequest;
  readonly ts: string;
}): Effect.Effect<void> =>
  input.reply
    .updateBlocks(
      input.ts,
      blockerAnsweredBlocks(
        input.request.question,
        input.answer === undefined
          ? "No answer — deciding without one."
          : answerLabel(input.request, input.answer)
      ),
      input.request.question
    )
    .pipe(bestEffort, Effect.withSpan("Slack.routes.retireQuestion"));

/**
 * Post the question and wait for the answer.
 *
 * Split from the route so the HTTP shell stays about decoding and status
 * codes. Returns undefined when nothing could be posted, which the caller
 * reports as a bad gateway rather than a timeout — the reader never saw it.
 */
const askAndWait = Effect.fn("Slack.routes.askAndWait")(
  function* (input: {
    readonly blockers: BlockersShape;
    readonly reply: MessageReplyShape;
    readonly request: AskRequest;
    readonly threadKey: string;
    readonly timeoutMs: number;
  }): Effect.fn.Return<AskOutcome | undefined> {
    const { askId, answered } = yield* input.blockers.open(input.threadKey);

    const blocks: readonly SlackBlock[] = blockerBlocks({
      askId,
      choices: input.request.choices,
      question: input.request.question,
    });

    const posted = yield* input.reply
      .replyBlocks(blocks, `Blocked: ${input.request.question}`)
      .pipe(
        Effect.andThen((message) => Effect.succeed(message.ts)),
        Effect.catchCause((cause) =>
          Effect.logError("[slack] could not post the blocker", cause).pipe(
            Effect.andThen(Effect.succeed(NO_TS))
          )
        )
      );

    if (posted === undefined) {
      // Nothing is on screen, so nothing can answer it. Settle the ask rather
      // than leaving it to be abandoned by a turn that may not know about it.
      yield* input.blockers.abandon(askId, "the blocker was never posted");
      return;
    }

    const answer: string | undefined = yield* Effect.promise(
      () => answered
    ).pipe(
      Effect.timeoutOrElse({
        duration: input.timeoutMs,
        orElse: () =>
          input.blockers
            .abandon(askId, "nobody answered")
            .pipe(Effect.andThen(Effect.succeed(NO_ANSWER))),
      })
    );

    yield* retireQuestion({
      answer,
      reply: input.reply,
      request: input.request,
      ts: posted,
    });

    return {
      timedOut: answer === undefined,
      value: answer ?? "",
    };
  }
);

export const makeBlockerRoute = (deps: {
  readonly blockers: BlockersShape;
  readonly replyFor: (ref: ThreadRef) => Promise<MessageReplyShape>;
  readonly threadKeyFor: (ref: ThreadRef) => string;
  readonly timeoutMs?: number;
  readonly workspaceTeamId: string;
}): ((request: Request) => Promise<Response>) =>
  loopbackRoute<AskRequest, { readonly answer: string }>({
    capKiB: MAX_ASK_BODY_KIB,
    handle: async ({ ref, request }) => {
      const outcome = await Effect.runPromise(
        askAndWait({
          blockers: deps.blockers,
          reply: await deps.replyFor(ref),
          request,
          threadKey: deps.threadKeyFor(ref),
          timeoutMs: deps.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS,
        })
      );

      if (outcome === undefined) {
        return refuse(HTTP_BAD_GATEWAY, "the blocker could not be posted");
      }

      return outcome.timedOut
        ? refuse(HTTP_TIMEOUT, "nobody answered")
        : Result.succeed({ answer: outcome.value });
    },
    parse: (raw): Result.Result<AskRequest, string> => {
      const parsed = parseAskBody(raw);
      return parsed.ok
        ? Result.succeed(parsed.request)
        : Result.fail(parsed.error);
    },
    workspaceTeamId: deps.workspaceTeamId,
  });
