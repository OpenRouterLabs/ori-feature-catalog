import type { Chat } from "ori";

import { Cause, Context, Effect, Schema } from "effect";

import type { PostedMessage, SlackClient } from "#src/client/index.ts";
import type { RawSlackMessage } from "#src/client/listeners.ts";
import type { SlackConfig } from "#src/config.ts";
import type { SlackBlock } from "#src/helpers/block-kit/blocks.ts";
import type { SlackLogger } from "#src/index.ts";
import type { BlockersShape } from "#src/interactions/blocker.ts";
import type { QuestionnairesShape } from "#src/interactions/questionnaires.ts";
import type { SlackServices } from "#src/layers.ts";
import type { InterruptMode as InterruptModeType } from "#src/state/settings.ts";
import type { ThreadRef } from "#src/thread/thread.ts";
import type { EngagementDeps } from "./listening/engagement.ts";
import type { IncomingMessage } from "./listening/gates.ts";

import { makeMessageReply } from "#src/message-reply/reply-live.ts";
import { InterruptMode } from "#src/state/settings.ts";
import { StateStore } from "#src/state/store.ts";
import { enqueue, isBusy, steerThread } from "#src/thread/registry.ts";
import { ThreadRefSchema, threadInstanceId } from "#src/thread/thread.ts";
import { withAttachments } from "./attachments/attachments.ts";
import { claimStart, considerTurn } from "./listening/engagement.ts";
import { handleTurn } from "./handler/handler.ts";
import { makeBlockerRoute } from "./routes/blocker-route.ts";
import { carrySession } from "./carry.ts";
import { makeCarryRoute } from "./routes/carry-route.ts";
import { makeAttachRoute } from "./routes/attach-route.ts";
import { makeChartRoute } from "./routes/chart-route.ts";
import { makeDispatchRoute } from "./routes/dispatch-route.ts";
import { makeImageRoute } from "./routes/image-route.ts";
import { makeQuestionsRoute } from "./routes/questions-route.ts";

export interface TurnRoutes {
  readonly handleAsk: (request: Request) => Promise<Response>;
  readonly handleAttach: (request: Request) => Promise<Response>;
  readonly handleCarry: (request: Request) => Promise<Response>;
  readonly handleDispatch: (request: Request) => Promise<Response>;
  readonly handleChart: (request: Request) => Promise<Response>;
  readonly handleImage: (request: Request) => Promise<Response>;
  readonly handleQuestions: (request: Request) => Promise<Response>;
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

interface RunTurnDeps {
  readonly bridge: Chat;
  readonly interruptMode: () => Effect.Effect<InterruptModeType>;
  readonly logger: SlackLogger;
  readonly postQueuedNotice: (ref: ThreadRef) => Promise<void>;
  readonly runWith: <A>(
    effect: Effect.Effect<A, never, SlackServices>
  ) => Promise<A>;
}

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
