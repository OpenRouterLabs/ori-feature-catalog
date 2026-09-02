import type { Chat } from "ori";

import { Cause, Context, Effect, Schema } from "effect";

import type { PostedMessage, SlackClient } from "#src/client/client.ts";
import type { RawSlackMessage } from "#src/client/listeners.ts";
import type { SlackConfig } from "#src/config.ts";
import type { SlackBlock } from "#src/helpers/block-kit/blocks.ts";
import type { SlackLogger } from "#src/index.ts";
import type { BlockersShape } from "#src/interactions/blocker.ts";
import type { QuestionnairesShape } from "#src/interactions/questionnaires.ts";
import type { SlackServices } from "#src/layers.ts";
import { InterruptMode, type InterruptMode as InterruptModeType } from "#src/state/settings.ts";
import { type ThreadRef, ThreadRefSchema, enqueue, isBusy, steerThread, threadInstanceId } from "#src/thread/index.ts";
import { claimStart, considerTurn, type EngagementDeps, EngagementDepsSchema } from "./listening/engagement.ts";
import type { IncomingMessage } from "./listening/gates.ts";

import { makeMessageReply } from "#src/message-reply/reply-live.ts";
import { functionSchema, opaqueSchema } from "#src/schema-support.ts";
import { StateStore } from "#src/state/store.ts";
import { withAttachments } from "./attachments/attachments.ts";
import { handleTurn } from "./handler/handler.ts";
import { makeBlockerRoute } from "./routes/blocker-route.ts";
import { carrySession } from "./carry.ts";
import { makeCarryRoute } from "./routes/carry-route.ts";
import { makeAttachRoute } from "./routes/attach-route.ts";
import { makeChartRoute } from "./routes/chart-route.ts";
import { makeDispatchRoute } from "./routes/dispatch-route.ts";
import { makeImageRoute } from "./routes/image-route.ts";
import { makeQuestionsRoute } from "./routes/questions-route.ts";

type RequestHandler = (request: Request) => Promise<Response>;

const TurnRoutesSchema = Schema.Struct({
  handleAsk: functionSchema<RequestHandler>("TurnRoutes.handleAsk"),
  handleAttach: functionSchema<RequestHandler>("TurnRoutes.handleAttach"),
  handleCarry: functionSchema<RequestHandler>("TurnRoutes.handleCarry"),
  handleDispatch: functionSchema<RequestHandler>("TurnRoutes.handleDispatch"),
  handleChart: functionSchema<RequestHandler>("TurnRoutes.handleChart"),
  handleImage: functionSchema<RequestHandler>("TurnRoutes.handleImage"),
  handleQuestions: functionSchema<RequestHandler>("TurnRoutes.handleQuestions"),
  runTurnSafely: functionSchema<
    (turn: {
      readonly ref: ThreadRef;
      readonly text: string;
      readonly userId: string;
    }) => void
  >("TurnRoutes.runTurnSafely"),
  startTurnSafely: functionSchema<
    (event: RawSlackMessage, addressed: boolean) => void
  >("TurnRoutes.startTurnSafely"),
});

export type TurnRoutes = typeof TurnRoutesSchema.Type;

export const shouldSteer = (
  steerable: boolean | undefined,
  mode: InterruptModeType
): boolean => steerable === true && mode === InterruptMode.Steer;

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

const queuedNotice =
  (steered: boolean, post: () => Promise<void>) => async (): Promise<void> => {
    if (!steered) {
      await post();
    }
  };

const RunTurnDepsSchema = Schema.Struct({
  bridge: opaqueSchema<Chat>("RunTurnDeps.bridge"),
  interruptMode: functionSchema<() => Effect.Effect<InterruptModeType>>(
    "RunTurnDeps.interruptMode"
  ),
  logger: opaqueSchema<SlackLogger>("RunTurnDeps.logger"),
  postQueuedNotice: functionSchema<(ref: ThreadRef) => Promise<void>>(
    "RunTurnDeps.postQueuedNotice"
  ),
  runWith: functionSchema<
    <A>(effect: Effect.Effect<A, never, SlackServices>) => Promise<A>
  >("RunTurnDeps.runWith"),
});

type RunTurnDeps = typeof RunTurnDepsSchema.Type;

const WorkerTurnSchema = Schema.Struct({
  attachmentWarning: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  steer: Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean)),
  ref: ThreadRefSchema,
  spawnDepth: Schema.optionalKey(Schema.UndefinedOr(Schema.Number)),
  startsThread: Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean)),
  text: Schema.String,
  userId: Schema.String,
});

type WorkerTurn = typeof WorkerTurnSchema.Type;

const makeRunTurn = (deps: RunTurnDeps) =>
  Effect.fn("Slack.turn.run")(function* (
    turn: WorkerTurn
  ): Effect.fn.Return<void, unknown> {
    const threadKey = threadInstanceId(turn.ref);
    const mode = yield* deps.interruptMode();
    const { steered, turn: redirected } = shouldSteer(turn.steer, mode)
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
          async (live) => {
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

const StartedTurnSchema = Schema.Struct({
  attachmentWarning: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  ref: ThreadRefSchema,
  startsThread: Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean)),
  steer: Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean)),
  text: Schema.String,
  userId: Schema.String,
});

type StartedTurn = typeof StartedTurnSchema.Type;

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
    const verdict = yield* considerTurn(deps.engagement, {
      addressed,
      key: threadInstanceId(ref),
      message: deps.messageOf(event),
      ref,
    });
    if (verdict === "drop") {
      return;
    }
    if (!deps.started(event.ts)) {
      return;
    }

    yield* Effect.tryPromise({
      try: () => deps.startStatus(ref),
      catch: (error: unknown) => error,
    });

    yield* runTheTurn(deps, event, ref).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("[slack] the turn died before it answered", cause).pipe(
          Effect.andThen(Effect.promise(() => deps.sayFailed(ref)))
        )
      )
    );
  });

const LoopbackTurnSchema = Schema.Struct({
  ref: ThreadRefSchema,
  spawnDepth: Schema.optionalKey(Schema.UndefinedOr(Schema.Number)),
  text: Schema.String,
  userId: Schema.String,
});

type LoopbackTurn = typeof LoopbackTurnSchema.Type;

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

const makeSideRoutes = (input: {
  readonly deps: TurnRouteDeps;
  readonly runTurnSafely: (turn: LoopbackTurn) => void;
}): {
  readonly ask: (request: Request) => Promise<Response>;
  readonly attach: (request: Request) => Promise<Response>;
  readonly carry: (request: Request) => Promise<Response>;
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
    carry: makeCarryRoute({
      carry: ({ from, to }) => deps.runWith(carrySession({ from, to })),
      isBusy: (ref) => isBusy(threadInstanceId(ref)),
      isStopping: deps.isStopping,
      workspaceTeamId: deps.workspaceTeamId,
    }),
    attach: makeAttachRoute({
      readFile: async (path) => new Blob([await Bun.file(path).arrayBuffer()]),
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
      isLive: (ref) => Promise.resolve(isBusy(threadInstanceId(ref))),
      newAskId: () => crypto.randomUUID(),
      post: async (ref, blocks, fallback) => {
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

const TurnRouteDepsSchema = Schema.Struct({
  blockers: opaqueSchema<BlockersShape>("TurnRouteDeps.blockers"),
  config: opaqueSchema<SlackConfig>("TurnRouteDeps.config"),
  bridge: opaqueSchema<Chat>("TurnRouteDeps.bridge"),
  context: opaqueSchema<Context.Context<SlackServices>>(
    "TurnRouteDeps.context"
  ),
  engagement: EngagementDepsSchema,
  isStopping: functionSchema<() => boolean>("TurnRouteDeps.isStopping"),
  logger: opaqueSchema<SlackLogger>("TurnRouteDeps.logger"),
  messageOf: functionSchema<(event: RawSlackMessage) => IncomingMessage>(
    "TurnRouteDeps.messageOf"
  ),
  postQueuedNotice: functionSchema<(ref: ThreadRef) => Promise<void>>(
    "TurnRouteDeps.postQueuedNotice"
  ),
  startStatus: functionSchema<(ref: ThreadRef) => Promise<void>>(
    "TurnRouteDeps.startStatus"
  ),
  sayFailed: functionSchema<(ref: ThreadRef) => Promise<void>>(
    "TurnRouteDeps.sayFailed"
  ),
  runWith: functionSchema<
    <A>(effect: Effect.Effect<A, never, SlackServices>) => Promise<A>
  >("TurnRouteDeps.runWith"),
  forms: opaqueSchema<QuestionnairesShape>("TurnRouteDeps.forms"),
  token: Schema.String,
  workspaceTeamId: Schema.String,
});

export type TurnRouteDeps = typeof TurnRouteDepsSchema.Type;

export const makeTurnRoutes = (deps: TurnRouteDeps): TurnRoutes => {
  const runTurn = makeRunTurn({
    bridge: deps.bridge,
    interruptMode: () => Context.get(deps.context, StateStore).getInterruptMode(),
    logger: deps.logger,
    postQueuedNotice: deps.postQueuedNotice,
    runWith: deps.runWith,
  });

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
    handleAttach: routes.attach,
    handleCarry: routes.carry,
    handleChart: routes.chart,
    handleImage: routes.image,
    handleDispatch: routes.dispatch,
    handleQuestions: routes.questions,
    runTurnSafely,
    startTurnSafely,
  };
};
