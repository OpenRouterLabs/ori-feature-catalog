/**
 * index.ts — the Slack feature's composition root.
 *
 * Holds one rule, which is the point of the RFC:
 *
 *   The service graph is built HERE, once. thread.ts, message-reply/,
 *   message-stream/, interactions/ and turn/ carry their dependencies as
 *   requirements and receive them. Nothing downstream calls `Effect.provide`.
 *
 * That is what makes the surface extensible. A dependency is only overridable
 * at a scope that can still see it: provide `SlackClient` inside a handler and
 * an outer layer supplied by another feature is silently discarded, because
 * the innermost provide wins.
 *
 * The graph is materialised once into a `Context` held for the process
 * lifetime — `StateStore` carries the thread -> session mapping, so rebuilding
 * per turn would mint a new agent session for every message.
 */

import type { App } from "@slack/bolt";
import type { Chat, StateStore as OriStateStore } from "ori";

import { Context, Effect, Layer, Scope } from "effect";

import type { SlackClientShape } from "./client/client.ts";
import type { RawSlackMessage } from "./client/listeners.ts";
import type { SlackReceiver } from "./client/receiver.ts";
import type { SlackConfig } from "./config.ts";
import type {
  InteractionPayload,
  InteractionsShape,
  ViewSubmissionPayload,
} from "./interactions/interactions.ts";
import type { SlackServices } from "./layers.ts";
import type { ThreadRef } from "./thread/thread.ts";
import type { IncomingMessage } from "./turn/gates.ts";
import type { TurnRouteDeps, TurnRoutes } from "./turn/turn-routes.ts";

import { goLive, makeBoltApp, makeStop } from "./client/bolt-lifecycle.ts";
import { SlackClient } from "./client/client.ts";
import { makeSurfaceEventHandlers } from "./client/surface-events.ts";
import { readSlackConfig } from "./config.ts";
import { forkWith } from "./fork.ts";
import { registerBlockerHandlers } from "./interactions/blocker-handler.ts";
import { Blockers } from "./interactions/blocker.ts";
import { Interactions } from "./interactions/interactions.ts";
import {
  registerCancelHandler,
  registerPermissionHandlers,
} from "./interactions/permissions.ts";
import { Questionnaires } from "./interactions/questionnaires.ts";
import { registerQuestionHandlers } from "./interactions/questions-handler.ts";
import { SlackDefaultLayers } from "./layers.ts";
import { setLoadingEmoji } from "./message-stream/run-state.ts";
import {
  engagementDeps,
  postQueuedNotice,
  sayFailed,
  startStatus,
} from "./notes.ts";
import { cancelTurn } from "./thread/registry.ts";
import { makeTurnRoutes } from "./turn/turn-routes.ts";


export interface SlackLogger {
  readonly error: (message: string, ...rest: readonly unknown[]) => void;
  readonly info: (message: string, ...rest: readonly unknown[]) => void;
  readonly warn: (message: string, ...rest: readonly unknown[]) => void;
}

export interface SlackRuntime {
  readonly handleAskRequest: (request: Request) => Promise<Response>;
  /**
   * The client this surface is running on.
   *
   * Published so `exports.ts` can hand `use("slack")` the SAME instance
   * rather than building a second one. The Slack SDK's rate-limit queue is
   * per client, so two instances are two queues that cannot see each other:
   * each well-behaved alone, and Slack seeing the sum.
   */
  readonly slack: SlackClientShape;
  readonly handleDispatchRequest: (request: Request) => Promise<Response>;
  readonly handleEventsRequest: (request: Request) => Promise<Response>;
  readonly handleChartRequest: (request: Request) => Promise<Response>;
  readonly handleImageRequest: (request: Request) => Promise<Response>;
  readonly handleQuestionsRequest: (request: Request) => Promise<Response>;
  readonly stop: () => Promise<void>;
}

/**
 * Build the graph once, with any registered extensions folded over it, and
 * keep the resulting context and its scope for the process lifetime.
 */
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
    })
  );

/** Run an Effect against the graph built at start. */
const runWith = <A>(
  context: Context.Context<SlackServices>,
  effect: Effect.Effect<A, never, SlackServices>
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provideContext(context)));

const messageOf = (event: RawSlackMessage): IncomingMessage => ({
  botId: event.bot_id,
  subtype: event.subtype,
  text: event.text ?? "",
  userId: event.user,
});

/** Who this bot is, as Slack sees it. */
interface SlackIdentity {
  /** Display name, for copy a reader sees. Falls back to a neutral noun. */
  readonly botName: string;
  readonly botUserId: string | undefined;
  readonly teamId: string;
}

const UNKNOWN_IDENTITY: SlackIdentity = {
  botName: "this bot",
  botUserId: undefined,
  teamId: "",
};

/**
 * Who and where this bot is, resolved once from a single `auth.test`.
 *
 * The team id matters most: without it the event path used `event.team` while
 * dispatch fell back to an env var that is not in the manifest, so the same
 * thread mapped to two different sessions depending on how the turn started.
 *
 * The user id is what lets auto-mute tell our own messages from another app's.
 * The name is only copy — the App Home tab tells a reader who to mention. Both
 * come from the same call, so asking for them costs nothing. An unreachable
 * `auth.test` degrades to placeholders rather than refusing to boot.
 */
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
          botUserId: identity.user_id,
          teamId: identity.team_id ?? "",
        };
      },
    }).pipe(Effect.catchCause(() => Effect.succeed(UNKNOWN_IDENTITY)))
  );

/**
 * Wire the approval buttons to the bridge.
 *
 * Approval buttons are only useful if we can answer with them, and the bridge
 * declares `respondInteraction` optionally — so feature-detect rather than
 * posting buttons that would go nowhere.
 */
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
};

/**
 * The two Bolt listeners that route back into the graph. Ignored on failure:
 * a click that cannot be handled must not fault the listener Slack is waiting
 * on, and both paths already log their own causes.
 */
const interactionDispatchers = (
  context: Context.Context<SlackServices>,
  interactions: InteractionsShape
): {
  readonly dispatchInteraction: (payload: InteractionPayload) => Promise<void>;
  readonly dispatchView: (payload: ViewSubmissionPayload) => Promise<void>;
} => ({
  dispatchInteraction: (payload: InteractionPayload): Promise<void> =>
    runWith(context, interactions.dispatch(payload).pipe(Effect.ignore)),
  dispatchView: (payload: ViewSubmissionPayload): Promise<void> =>
    runWith(context, interactions.dispatchView(payload).pipe(Effect.ignore)),
});

/**
 * Everything the turn path needs, pulled out of the graph. Both entry points
 * — a Slack event and the loopback dispatch route — land in the same path.
 */
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
    postQueuedNotice(input.context, ref),
  sayFailed: (ref: ThreadRef): Promise<void> => sayFailed(input.context, ref),
  startStatus: (ref: ThreadRef): Promise<void> =>
    startStatus(input.context, ref),
  runWith: <A>(effect: Effect.Effect<A, never, SlackServices>): Promise<A> =>
    runWith(input.context, effect),
  config: input.config,
  token: input.config.token,
  workspaceTeamId: input.identity.teamId,
});

/**
 * Register every handler and open the surface for traffic.
 *
 * The order is load-bearing: the interaction and event handlers have to be
 * registered BEFORE `app.start()`, or the first click after boot lands on a
 * router that has nothing for it.
 */
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

  // After `makeTurnRoutes`, because answering a form STARTS a turn and only
  // the routes know how.
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

/**
 * The handles `feature.ts` routes to, from the pieces that serve them.
 *
 * Mechanical, and separate for that reason: every route this surface exposes is
 * named in one place, so adding one is a single obvious edit rather than a line
 * buried in the boot sequence.
 */
const runtimeOf = (input: {
  readonly receiver: SlackReceiver;
  readonly routes: TurnRoutes;
  readonly slack: SlackClientShape;
  readonly stop: () => Promise<void>;
}): SlackRuntime => ({
  handleAskRequest: input.routes.handleAsk,
  handleChartRequest: input.routes.handleChart,
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
  // Decoded once, here. Nothing downstream reaches for `Bun.env` mid-turn.
  const config = readSlackConfig();
  setLoadingEmoji(config.loadingEmoji);
  const { token } = config;

  /** Set by `stop()` so no new work is admitted while in-flight turns drain. */
  let stopping = false;
  /**
   * Resolved after the graph is built, because `auth.test` needs the client the
   * graph provides. `Home` reads the name through a thunk for exactly this
   * reason — it is published on demand, long after boot.
   */
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
