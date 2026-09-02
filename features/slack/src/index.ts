import type { App } from "@slack/bolt";
import type { Chat, StateStore as OriStateStore } from "ori";

import { Context, Effect, Layer, Schema, Scope } from "effect";

import { bestEffort } from "./helpers/best-effort.ts";

import { SlackClient, type SlackClientShape, SlackClientShapeSchema } from "./client/client.ts";
import type { RawSlackMessage } from "./client/listeners.ts";
import type { SlackReceiver } from "./client/receiver.ts";
import { type SlackConfig, readSlackConfig } from "./config.ts";
import { type InteractionPayload, Interactions, type InteractionsShape, type ViewSubmissionPayload } from "./interactions/interactions.ts";
import { SlackDefaultLayers, type SlackServices } from "./layers.ts";
import { type ThreadRef, cancelTurn } from "./thread/index.ts";
import type { IncomingMessage } from "./turn/listening/gates.ts";
import { type TurnRouteDeps, type TurnRoutes, makeTurnRoutes } from "./turn/turn-routes.ts";

import { makeSurfaceEventHandlers } from "./client/surface-events.ts";
import { goLive, makeBoltApp, makeStop } from "./client/bolt-lifecycle.ts";
import { makeDashboardRoute } from "./dashboard/dashboard.ts";
import { forkWith } from "./fork.ts";
import { functionSchema, opaqueSchema } from "./schema-support.ts";
import { registerBlockerHandlers } from "./interactions/blocker-handler.ts";
import { registerCustomButtons } from "./interactions/custom.ts";
import { Blockers } from "./interactions/blocker.ts";
import {
  registerCancelHandler,
  registerPermissionHandlers,
} from "./interactions/permissions.ts";
import { Questionnaires } from "./interactions/questionnaires.ts";
import { registerQuestionHandlers } from "./interactions/questions-handler.ts";
import { StateStore } from "./state/store.ts";
import { setLoadingEmoji } from "./message-stream/run-state.ts";
import {
  engagementDeps,
  postQueuedNotice,
  sayFailed,
  startStatus,
} from "./notes.ts";

const SlackLoggerSchema = Schema.Struct({
  error:
    functionSchema<(message: string, ...rest: readonly unknown[]) => void>(
      "SlackLogger.error"
    ),
  info:
    functionSchema<(message: string, ...rest: readonly unknown[]) => void>(
      "SlackLogger.info"
    ),
  warn:
    functionSchema<(message: string, ...rest: readonly unknown[]) => void>(
      "SlackLogger.warn"
    ),
});

export type SlackLogger = typeof SlackLoggerSchema.Type;

type RequestHandler = (request: Request) => Promise<Response>;

const requestHandlerSchema = (
  identifier: string
): Schema.declare<RequestHandler, RequestHandler> =>
  functionSchema<RequestHandler>(identifier);

const SlackRuntimeSchema = Schema.Struct({
  context:
    opaqueSchema<Context.Context<SlackServices>>("SlackRuntime.context"),
  handleAskRequest: requestHandlerSchema("SlackRuntime.handleAskRequest"),
  slack: SlackClientShapeSchema,
  handleDispatchRequest: requestHandlerSchema(
    "SlackRuntime.handleDispatchRequest"
  ),
  handleEventsRequest: requestHandlerSchema("SlackRuntime.handleEventsRequest"),
  handleCarryRequest: requestHandlerSchema("SlackRuntime.handleCarryRequest"),
  handleAttachRequest: requestHandlerSchema("SlackRuntime.handleAttachRequest"),
  handleChartRequest: requestHandlerSchema("SlackRuntime.handleChartRequest"),
  handleDashboardRequest: requestHandlerSchema(
    "SlackRuntime.handleDashboardRequest"
  ),
  handleImageRequest: requestHandlerSchema("SlackRuntime.handleImageRequest"),
  handleQuestionsRequest: requestHandlerSchema(
    "SlackRuntime.handleQuestionsRequest"
  ),
  stop: functionSchema<() => Promise<void>>("SlackRuntime.stop"),
});

export type SlackRuntime = typeof SlackRuntimeSchema.Type;

const buildContext = (input: {
  readonly botName: () => string;
  readonly isStopping: () => boolean;
  readonly store?: OriStateStore | undefined;
  readonly token: string;
}): Promise<{
  readonly context: Context.Context<SlackServices>;
  readonly scope: Scope.Closeable;
}> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.build(
        SlackDefaultLayers(input)
      ).pipe(Effect.provideService(Scope.Scope, scope));
      return {
        context,
        scope,
      };
    }).pipe(Effect.withSpan("Slack.runtime.buildContext"))
  );

const runWith = <A>(
  context: Context.Context<SlackServices>,
  effect: Effect.Effect<A, never, SlackServices>
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideContext(context),
      Effect.withSpan("Slack.runtime.runWith")
    )
  );

const messageOf = (event: RawSlackMessage): IncomingMessage => ({
  botId: event.bot_id,
  subtype: event.subtype,
  text: event.text ?? "",
  userId: event.user,
});

const SlackIdentitySchema = Schema.Struct({
  botName: Schema.String,
  botId: Schema.UndefinedOr(Schema.String),
  botUserId: Schema.UndefinedOr(Schema.String),
  teamId: Schema.String,
});

type SlackIdentity = typeof SlackIdentitySchema.Type;

const UNKNOWN_IDENTITY: SlackIdentity = {
  botName: "this bot",
  botId: undefined,
  botUserId: undefined,
  teamId: "",
};

const resolveIdentity = (
  context: Context.Context<SlackServices>
): Promise<SlackIdentity> =>
  Effect.runPromise(
    Effect.tryPromise({
      catch: (cause) => new Error(`auth.test failed: ${String(cause)}`),
      try: async (): Promise<SlackIdentity> => {
        const identity = await Context.get(
          context,
          SlackClient
        ).raw.auth.test();
        return {
          botName: identity.user ?? UNKNOWN_IDENTITY.botName,
          botId: identity.bot_id,
          botUserId: identity.user_id,
          teamId: identity.team_id ?? "",
        };
      },
    }).pipe(
      Effect.tapCause((cause) =>
        Effect.logError("[slack] could not resolve the bot identity", cause)
      ),
      Effect.catchCause(() => Effect.succeed(UNKNOWN_IDENTITY)),
      Effect.withSpan("Slack.runtime.resolveIdentity")
    )
  );

const registerInteractionHandlers = (input: {
  readonly bridge: Chat;
  readonly context: Context.Context<SlackServices>;
  readonly interactions: InteractionsShape;
  readonly logger: SlackLogger;
}): void => {
  const { respondInteraction } = input.bridge;
  if (respondInteraction === undefined) {
    input.logger.warn(
      "[slack] host has no respondInteraction — permission prompts will not be answerable"
    );
  } else {
    registerPermissionHandlers(input.interactions, {
      respond: (response) => respondInteraction(response),
    });
  }

  registerBlockerHandlers({
    blockers: Context.get(input.context, Blockers),
    interactions: input.interactions,
  });

  registerCancelHandler(input.interactions, cancelTurn);

  const custom = registerCustomButtons(input.interactions);
  if (custom.length > 0) {
    input.logger.info(`[slack] custom buttons wired: ${custom.join(", ")}`);
  }
};

const interactionDispatchers = (
  context: Context.Context<SlackServices>,
  interactions: InteractionsShape
): {
  readonly dispatchInteraction: (payload: InteractionPayload) => Promise<void>;
  readonly dispatchView: (payload: ViewSubmissionPayload) => Promise<void>;
} => ({
  dispatchInteraction: (payload: InteractionPayload): Promise<void> =>
    runWith(context, interactions.dispatch(payload).pipe(bestEffort)),
  dispatchView: (payload: ViewSubmissionPayload): Promise<void> =>
    runWith(context, interactions.dispatchView(payload).pipe(bestEffort)),
});

const turnRouteDeps = (input: {
  readonly bridge: Chat;
  readonly config: SlackConfig;
  readonly context: Context.Context<SlackServices>;
  readonly identity: SlackIdentity;
  readonly isStopping: () => boolean;
  readonly logger: SlackLogger;
}): TurnRouteDeps => ({
  blockers: Context.get(input.context, Blockers),
  forms: Context.get(input.context, Questionnaires),
  bridge: input.bridge,
  context: input.context,
  engagement: engagementDeps({
    botUserId: input.identity.botUserId,
    config: input.config,
    context: input.context,
  }),
  isStopping: input.isStopping,
  logger: input.logger,
  messageOf,
  postQueuedNotice: (ref: ThreadRef): Promise<void> =>
    runWith(input.context, postQueuedNotice(ref)),
  sayFailed: (ref: ThreadRef): Promise<void> =>
    runWith(input.context, sayFailed(ref)),
  startStatus: (ref: ThreadRef): Promise<void> =>
    runWith(input.context, startStatus(ref)),
  runWith: <A>(effect: Effect.Effect<A, never, SlackServices>): Promise<A> =>
    runWith(input.context, effect),
  config: input.config,
  token: input.config.token,
  workspaceTeamId: input.identity.teamId,
});

const openForTraffic = async (input: {
  readonly bridge: Chat;
  readonly config: SlackConfig;
  readonly context: Context.Context<SlackServices>;
  readonly identity: SlackIdentity;
  readonly isStopping: () => boolean;
  readonly logger: SlackLogger;
}): Promise<{
  readonly app: App;
  readonly receiver: SlackReceiver;
  readonly routes: TurnRoutes;
}> => {
  const interactions: InteractionsShape = Context.get(
    input.context,
    Interactions
  );
  registerInteractionHandlers({
    bridge: input.bridge,
    context: input.context,
    interactions,
    logger: input.logger,
  });

  const { app, receiver } = makeBoltApp({
    identity: input.identity,
    logger: input.logger,
    signingSecret: input.config.signingSecret,
    token: input.config.token,
  });

  const routes = makeTurnRoutes(
    turnRouteDeps({
      bridge: input.bridge,
      config: input.config,
      context: input.context,
      identity: input.identity,
      isStopping: input.isStopping,
      logger: input.logger,
    })
  );

  registerQuestionHandlers({
    continueTurn: (form, prompt) => {
      routes.runTurnSafely({
        ref: form.ref,
        text: prompt,
        userId: "",
      });
    },
    forms: Context.get(input.context, Questionnaires),
    interactions,
    slack: Context.get(input.context, SlackClient),
  });

  await goLive({
    app,
    ...interactionDispatchers(input.context, interactions),
    ...makeSurfaceEventHandlers({
      context: input.context,
      runWith: forkWith(input.context),
    }),
    logger: input.logger,
    startTurn: routes.startTurnSafely,
  });

  return {
    app,
    receiver,
    routes,
  };
};

const runtimeOf = (input: {
  readonly context: Context.Context<SlackServices>;
  readonly receiver: SlackReceiver;
  readonly routes: TurnRoutes;
  readonly dashboard: (request: Request) => Promise<Response>;
  readonly slack: SlackClientShape;
  readonly stop: () => Promise<void>;
}): SlackRuntime => ({
  context: input.context,
  handleAskRequest: input.routes.handleAsk,
  handleCarryRequest: input.routes.handleCarry,
  handleAttachRequest: input.routes.handleAttach,
  handleChartRequest: input.routes.handleChart,
  handleDashboardRequest: input.dashboard,
  handleDispatchRequest: input.routes.handleDispatch,
  handleEventsRequest: (request: Request): Promise<Response> =>
    input.receiver.handleRequest(request),
  handleImageRequest: input.routes.handleImage,
  handleQuestionsRequest: input.routes.handleQuestions,
  slack: input.slack,
  stop: input.stop,
});

export const startSlackRuntime = async (input: {
  readonly bridge: Chat;
  readonly logger: SlackLogger;
}): Promise<SlackRuntime> => {
  const config = readSlackConfig();
  setLoadingEmoji(config.loadingEmoji);
  const { token } = config;

  let stopping = false;
  let identity = UNKNOWN_IDENTITY;

  const { context, scope } = await buildContext({
    botName: () => identity.botName,
    isStopping: () => stopping,
    store: input.bridge.stores?.state,
    token,
  });

  identity = await resolveIdentity(context);

  const { app, receiver, routes } = await openForTraffic({
    bridge: input.bridge,
    config,
    context,
    identity,
    isStopping: () => stopping,
    logger: input.logger,
  });

  return runtimeOf({
    context,
    dashboard: makeDashboardRoute(Context.get(context, StateStore)),
    receiver,
    routes,
    slack: Context.get(context, SlackClient),
    stop: makeStop({
      app,
      logger: input.logger,
      markStopping: (): void => {
        stopping = true;
      },
      receiver,
      scope,
    }),
  });
};
