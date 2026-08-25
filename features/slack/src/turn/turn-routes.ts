/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * turn-routes.ts — the two ways a turn starts, and the queueing they share.
 *
 * A Slack event and the loopback dispatch route the spawn-thread skill uses
 * both land in `runTurn`, so serialisation, cancellation and the turn deadline
 * behave identically whichever way a turn began.
 *
 * Built as a factory over the composition root's dependencies rather than
 * importing them, because the service graph is built once at start and held
 * for the process lifetime — see `index.ts`.
 *
 * A turn is one Effect from the thread claim to the last thing it posts. The
 * two detached launches at the bottom are where it is entered, and they are
 * edges: Slack's three-second ack means neither may be awaited, and a turn is
 * interrupted through the registry's `AbortSignal` rather than through its
 * fiber, so there is nothing a fork would buy.
 */

import type { Context } from "effect";
import type { Chat } from "ori";

import { Cause, Effect } from "effect";

import type { PostedMessage, SlackClient } from "../client/client.ts";
import type { RawSlackMessage } from "../client/listeners.ts";
import type { SlackConfig } from "../config.ts";
import type { SlackBlock } from "../helpers/block-kit/blocks.ts";
import type { SlackLogger } from "../index.ts";
import type { BlockersShape } from "../interactions/blocker.ts";
import type { QuestionnairesShape } from "../interactions/questionnaires.ts";
import type { SlackServices } from "../layers.ts";
import type { ThreadRef } from "../thread/thread.ts";
import type { EngagementDeps } from "./engagement.ts";
import type { IncomingMessage } from "./gates.ts";

import { makeMessageReply } from "../message-reply/reply-live.ts";
import { enqueue, isBusy, steerThread } from "../thread/registry.ts";
import { threadInstanceId } from "../thread/thread.ts";
import { withAttachments } from "./attachments/attachments.ts";
import { claimStart, considerTurn } from "./engagement.ts";
import { handleTurn } from "./handler/handler.ts";
import { makeBlockerRoute } from "./routes/blocker-route.ts";
import { makeChartRoute } from "./routes/chart-route.ts";
import { makeDispatchRoute } from "./routes/dispatch-route.ts";
import { makeImageRoute } from "./routes/image-route.ts";
import { makeQuestionsRoute } from "./routes/questions-route.ts";

export interface TurnRoutes {
  readonly handleAsk: (request: Request) => Promise<Response>;
  readonly handleDispatch: (request: Request) => Promise<Response>;
  readonly handleChart: (request: Request) => Promise<Response>;
  readonly handleImage: (request: Request) => Promise<Response>;
  readonly handleQuestions: (request: Request) => Promise<Response>;
  /** Start a turn nobody's message asked for — how answers resume a run. */
  readonly runTurnSafely: (turn: {
    readonly ref: ThreadRef;
    readonly text: string;
    readonly userId: string;
  }) => void;
  readonly startTurnSafely: (
    event: RawSlackMessage,
    addressed: boolean
  ) => void;
}

/**
 * Redirect a live turn into this one, if there is one.
 *
 * A second message in a busy thread used to queue behind it, so a correction
 * landed only after the run it was correcting had finished — the one moment it
 * was worth nothing. The interrupted turn's work rides along as `priorPartial`,
 * and what it was ASKED rides along as `priorAsk` — without that second half a
 * correction reads as the whole assignment rather than an amendment to one.
 */
const steerInto = <T extends object>(
  threadKey: string,
  turn: T
): { readonly steered: boolean; readonly turn: T } => {
  const steered = steerThread(threadKey);
  return steered === undefined
    ? {
        steered: false,
        turn,
      }
    : {
        steered: true,
        turn: {
          ...turn,
          priorAsk: steered.ask,
          priorPartial: steered.partial,
        },
      };
};

/**
 * A steer is not a queue. The turn it replaced is unwinding, so the wait is
 * momentary — and "starting once the current run finishes" sends the reader
 * looking for work that is not there.
 */
const queuedNotice =
  (steered: boolean, post: () => Promise<void>) => async (): Promise<void> => {
    if (!steered) {
      await post();
    }
  };

interface RunTurnDeps {
  readonly bridge: Chat;
  readonly logger: SlackLogger;
  readonly postQueuedNotice: (ref: ThreadRef) => Promise<void>;
  readonly runWith: <A>(
    effect: Effect.Effect<A, never, SlackServices>
  ) => Promise<A>;
}

interface WorkerTurn {
  readonly attachmentWarning?: string | undefined;
  /** True for a person's message, false for a dispatched one. */
  readonly steer?: boolean | undefined;
  readonly ref: ThreadRef;
  readonly spawnDepth?: number | undefined;
  readonly startsThread?: boolean | undefined;
  readonly text: string;
  readonly userId: string;
}

/**
 * One turn, from the thread claim to the last thing the run posts.
 *
 * `enqueue` stays the registry's own Promise edge — it is contracted to reject
 * with exactly what the work rejected with — so the rejection is carried
 * across as a failure rather than a defect, and the launchers below log the
 * value the `.catch` used to be handed.
 */
const makeRunTurn = (deps: RunTurnDeps) =>
  Effect.fn("Slack.turn.run")(function* (
    turn: WorkerTurn
  ): Effect.fn.Return<void, unknown> {
    const threadKey = threadInstanceId(turn.ref);
    // A dispatched or spawned turn never steers: nobody asked for the running
    // one to stop, and it used to be killed by any turn that arrived.
    const { steered, turn: redirected } =
      turn.steer === true
        ? steerInto(threadKey, turn)
        : {
            steered: false,
            turn,
          };

    yield* Effect.tryPromise({
      try: () =>
        enqueue(
          threadKey,
          queuedNotice(steered, () => deps.postQueuedNotice(turn.ref)),
          // `runWith` is the composition root's contract, not a round trip:
          // the services live outside this graph and are entered per turn.
          async (live) => {
            // `ensuring` rather than a `finally` around the run: nothing may
            // outlive the turn that owns it, and a turn that ended abnormally
            // leaves the agent run behind it still blocked on an answer that
            // is never coming, with no one left to render it. On a turn that
            // finished normally the stream is already exhausted and this is a
            // no-op.
            await deps.runWith(
              handleTurn({
                bridge: deps.bridge,
                live,
                turn: redirected,
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.sync(() => {
                    deps.logger.error("[slack] turn failed", cause);
                  })
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    live.abort();
                  })
                )
              )
            );
          }
        ),
      catch: (error: unknown) => error,
    });
  });

/**
 * Turn a Slack message event into a turn: decide whether it is one, fetch any
 * attachments, then hand it to `runTurn`.
 */
/** A turn a person's message starts, once it has been judged worth running. */
interface StartedTurn {
  readonly attachmentWarning?: string | undefined;
  readonly ref: ThreadRef;
  readonly startsThread?: boolean | undefined;
  /** True for a person's message, false for a dispatched one. */
  readonly steer?: boolean | undefined;
  readonly text: string;
  readonly userId: string;
}

/**
 * A reply threads under the message that started it; a top-level mention
 * starts a new thread rooted at itself — and that thread has no history, so
 * the cold-start read can be skipped entirely.
 */
const runTheTurn = Effect.fn("Slack.turn.runWithAttachments")(function* (
  deps: {
    readonly runTurn: (turn: StartedTurn) => Effect.Effect<void, unknown>;
    readonly token: string;
  },
  event: RawSlackMessage,
  ref: ThreadRef
): Effect.fn.Return<void, unknown> {
  const startsThread = event.thread_ts === undefined;
  const text = event.text ?? "";
  yield* withAttachments(
    {
      event,
      token: deps.token,
    },
    (attachmentWarning) =>
      deps.runTurn({
        attachmentWarning,
        ref,
        startsThread,
        // A person's second message steers the run they are correcting. A
        // dispatched turn never does — nobody asked for that one to stop.
        steer: true,
        text,
        userId: event.user ?? "",
      })
  );
});

const makeStartTurn = (deps: {
  readonly engagement: EngagementDeps;
  readonly startStatus: (ref: ThreadRef) => Promise<void>;
  readonly sayFailed: (ref: ThreadRef) => Promise<void>;
  readonly messageOf: (event: RawSlackMessage) => IncomingMessage;
  readonly runTurn: (turn: StartedTurn) => Effect.Effect<void, unknown>;
  readonly started: (ts: string | undefined) => boolean;
  readonly token: string;
  readonly workspaceTeamId: string;
}) =>
  Effect.fn("Slack.turn.start")(function* (
    event: RawSlackMessage,
    addressed: boolean
  ): Effect.fn.Return<void, unknown> {
    const channelId = event.channel;
    const threadTs = event.thread_ts ?? event.ts;
    if (channelId === undefined || threadTs === undefined) {
      return;
    }

    const ref = {
      channelId,
      teamId: event.team ?? deps.workspaceTeamId,
      threadTs,
    };
    // These two are the surface's own promises, handed in by the composition
    // root. A rejection from either belongs to the launcher below, not to the
    // recovery around the turn: nothing has been said in the thread yet, so
    // there is nothing to correct.
    const verdict = yield* Effect.tryPromise({
      try: () =>
        considerTurn(deps.engagement, {
          addressed,
          key: threadInstanceId(ref),
          message: deps.messageOf(event),
          ref,
        }),
      catch: (error: unknown) => error,
    });
    if (verdict === "drop") {
      return;
    }
    if (!deps.started(event.ts)) {
      return;
    }

    // Before the chatter, which is itself a model call: the indicator is the
    // only thing a reader has until something is posted, and it should not
    // wait on anything to appear.
    yield* Effect.tryPromise({
      try: () => deps.startStatus(ref),
      catch: (error: unknown) => error,
    });

    // Everything past here can throw — attachments, the chatter, the session
    // lookup — and a throw used to be logged and nothing else, leaving the
    // thread silent. Silence is the one outcome a reader cannot act on.
    yield* runTheTurn(deps, event, ref).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("[slack] the turn died before it answered", cause).pipe(
          Effect.andThen(Effect.promise(() => deps.sayFailed(ref)))
        )
      )
    );
  });

/** A turn a route asked for rather than a person: no chatter, no steer. */
interface LoopbackTurn {
  readonly ref: ThreadRef;
  readonly spawnDepth?: number | undefined;
  readonly text: string;
  readonly userId: string;
}

/**
 * Post a questionnaire, and say where it landed.
 *
 * Slack refusing the post is not the route's failure to report: the form is
 * still recorded, without a `messageTs`, which is how `questions-handler.ts`
 * knows there is no message to retire on submit.
 */
const postForm = Effect.fn("Slack.turn.postForm")(function* (input: {
  readonly blocks: readonly SlackBlock[];
  readonly fallback: string;
  readonly ref: ThreadRef;
}): Effect.fn.Return<PostedMessage | void, never, SlackClient> {
  const reply = yield* makeMessageReply(input.ref);
  return yield* reply
    .replyBlocks(input.blocks, input.fallback)
    .pipe(Effect.orElseSucceed(() => {}));
});

/** The loopback routes, built together because they share the graph. */
const makeSideRoutes = (input: {
  readonly deps: TurnRouteDeps;
  readonly runTurnSafely: (turn: LoopbackTurn) => void;
}): {
  readonly ask: (request: Request) => Promise<Response>;
  readonly chart: (request: Request) => Promise<Response>;
  readonly dispatch: (request: Request) => Promise<Response>;
  readonly image: (request: Request) => Promise<Response>;
  readonly questions: (request: Request) => Promise<Response>;
} => {
  const { deps } = input;
  return {
    ask: makeBlockerRoute({
      blockers: deps.blockers,
      threadKeyFor: threadInstanceId,
      replyFor: (ref) => deps.runWith(makeMessageReply(ref)),
      workspaceTeamId: deps.workspaceTeamId,
    }),
    chart: makeChartRoute({
      replyFor: (ref) => deps.runWith(makeMessageReply(ref)),
      workspaceTeamId: deps.workspaceTeamId,
    }),
    image: makeImageRoute({
      apiKey: () => deps.config.openRouterApiKey ?? "",
      model: deps.config.imageModel,
      replyFor: (ref) => deps.runWith(makeMessageReply(ref)),
      workspaceTeamId: deps.workspaceTeamId,
    }),
    dispatch: makeDispatchRoute({
      isStopping: deps.isStopping,
      runTurnSafely: input.runTurnSafely,
      workspaceTeamId: deps.workspaceTeamId,
    }),
    questions: makeQuestionsRoute({
      forms: deps.forms,
      // Asked of the registry, which is where the answer actually lives. This
      // used to ride on the status sink's `restore` — true when a turn owned
      // the thread, and a side effect on the indicator besides.
      isLive: (ref) => Promise.resolve(isBusy(threadInstanceId(ref))),
      newAskId: () => crypto.randomUUID(),
      post: async (ref, blocks, fallback) => {
        // One crossing, not two: the reply is built and used in the same
        // fiber, so the services are entered once per form rather than once
        // to make the surface and again to post through it.
        const posted = await deps.runWith(
          postForm({
            blocks: blocks as readonly SlackBlock[],
            fallback,
            ref,
          })
        );
        return posted?.ts;
      },
      workspaceTeamId: deps.workspaceTeamId,
    }),
  };
};

export interface TurnRouteDeps {
  readonly blockers: BlockersShape;
  readonly config: SlackConfig;
  readonly bridge: Chat;
  readonly context: Context.Context<SlackServices>;
  readonly engagement: EngagementDeps;
  readonly isStopping: () => boolean;
  readonly logger: SlackLogger;
  readonly messageOf: (event: RawSlackMessage) => IncomingMessage;
  readonly postQueuedNotice: (ref: ThreadRef) => Promise<void>;
  readonly startStatus: (ref: ThreadRef) => Promise<void>;
  readonly sayFailed: (ref: ThreadRef) => Promise<void>;
  readonly runWith: <A>(
    effect: Effect.Effect<A, never, SlackServices>
  ) => Promise<A>;
  readonly forms: QuestionnairesShape;
  readonly token: string;
  readonly workspaceTeamId: string;
}

export const makeTurnRoutes = (deps: TurnRouteDeps): TurnRoutes => {
  const runTurn = makeRunTurn({
    bridge: deps.bridge,
    logger: deps.logger,
    postQueuedNotice: deps.postQueuedNotice,
    runWith: deps.runWith,
  });

  /**
   * Detached deliberately — see `listeners.ts` for why that is load-bearing.
   *
   * `runPromise` rather than a fork: there is no fiber here to fork from, the
   * factory is plain TypeScript, and a turn is interrupted through the
   * registry's `AbortSignal` rather than through its fiber — so forking would
   * move nothing and would put shutdown's drain behind a scope that nobody
   * closes. The cause is squashed back to the value the old `.catch` was
   * handed, so a failure and a throw log the same thing they always did.
   */
  const runTurnSafely = (turn: Parameters<typeof runTurn>[0]): void => {
    void Effect.runPromise(
      runTurn(turn).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            deps.logger.error(
              "[slack] dispatched turn failed",
              Cause.squash(cause)
            );
          })
        )
      )
    );
  };

  const startTurn = makeStartTurn({
    engagement: deps.engagement,
    sayFailed: deps.sayFailed,
    startStatus: deps.startStatus,
    messageOf: deps.messageOf,
    runTurn,
    started: claimStart(),
    token: deps.token,
    workspaceTeamId: deps.workspaceTeamId,
  });

  /** Detached deliberately — see `runTurnSafely` above. */
  const startTurnSafely = (
    event: RawSlackMessage,
    addressed: boolean
  ): void => {
    void Effect.runPromise(
      startTurn(event, addressed).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            deps.logger.error("[slack] turn failed", Cause.squash(cause));
          })
        )
      )
    );
  };

  const routes = makeSideRoutes({
    deps,
    runTurnSafely,
  });

  return {
    handleAsk: routes.ask,
    handleChart: routes.chart,
    handleImage: routes.image,
    handleDispatch: routes.dispatch,
    handleQuestions: routes.questions,
    runTurnSafely,
    startTurnSafely,
  };
};
