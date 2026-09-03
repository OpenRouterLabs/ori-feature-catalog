/**
 * feature.ts — the Slack chat surface's contribution entry.
 *
 * Registered as `slack` so this workspace feature shadows the framework
 * builtin. The runtime is imported dynamically: the catalog registers every
 * chat surface in every ori process, and an eager import would pull Bolt into
 * TUI sessions that never select it.
 *
 * The handle lives in `src/feature-state.ts`, the feature's one `globalThis`
 * slot. Ori rebuilds this feature per load — `importFreshModule` bundles it
 * to a temp file and imports that — so module scope is per-load, and `start`
 * would set a binding one copy owns while the route handler reads `undefined`
 * in another. Every request then answers 503 while boot reports the surface
 * live. That shipped once, in #31. Nothing inside the bundle can bridge it,
 * so the runtime goes in the slot and everything else comes off the Effect
 * context it carries.
 */

import type { WebClient } from "@slack/web-api";
import type {
  ApiContribution,
  ApiRouteHandler,
  Chat,
  ChatContribution,
} from "ori";

import type {
  SlackButtonHandler,
  SlackPostMessageInput,
  SlackPostMessageResult,
} from "./src/exports.ts";
import type { SlackRuntime } from "./src/index.ts";

import { featureState } from "./src/feature-state.ts";
import { isLoopback } from "./src/turn/routes/dispatch.ts";

const HTTP_FORBIDDEN = 403;
const HTTP_SERVICE_UNAVAILABLE = 503;

type Answer = Promise<Response> | Response;

const withRuntime = (reach: (runtime: SlackRuntime) => Answer): Answer => {
  const { runtime } = featureState();
  return runtime === undefined
    ? Response.json(
        { error: "slack chat surface is not running" },
        { status: HTTP_SERVICE_UNAVAILABLE }
      )
    : reach(runtime);
};

/**
 * A loopback-only entry.
 *
 * Guarded in-handler rather than by the bind address: these are served on the
 * same port as the public webhook, so anything that can reach the webhook
 * could otherwise drive them. The path is read off the request so an entry
 * cannot log a route it is not serving.
 */
const loopbackEntry =
  (
    reach: (runtime: SlackRuntime, request: Request) => Answer
  ): ApiRouteHandler =>
  (request, { logger, remoteAddress }) => {
    if (!isLoopback(remoteAddress)) {
      logger.warn("rejected a non-loopback loopback request", {
        path: new URL(request.url).pathname,
        remoteAddress,
      });
      return Response.json({ error: "Forbidden" }, { status: HTTP_FORBIDDEN });
    }
    return withRuntime((runtime) => reach(runtime, request));
  };

const makeLazySlackChat = (): ChatContribution => {
  let active: SlackRuntime | undefined;

  return {
    name: "slack",

    async start(bridge: Chat) {
      const { startSlackRuntime } = await import("./src/index.ts");
      active = await startSlackRuntime({ bridge, logger: console });
      featureState().runtime = active;
    },

    async stop() {
      await active?.stop();
      const state = featureState();
      if (state.runtime === active) {
        state.runtime = undefined;
      }
      active = undefined;
    },
  };
};

export const chat: ChatContribution = makeLazySlackChat();

export const api = {
  /**
   * Omitting this does not fail to compile at the call site: the generated SDK
   * declares `FeatureApis.slack` whether or not a feature implements it, so
   * `use("slack")` would resolve to nothing at run time instead. Lazy for the
   * same reason as the surface.
   */
  exports: {
    postMessage: (
      input: SlackPostMessageInput
    ): Promise<SlackPostMessageResult> =>
      import("./src/exports.ts").then(({ postMessage }) => postMessage(input)),

    /**
     * The configured `WebClient`, for anything the typed surface does not
     * model. A function rather than the client itself: `exports` is evaluated
     * whenever this module loads, and building one eagerly would demand a
     * token in every ori process and pull `@slack/web-api` into the TUI.
     */
    webClient: (): Promise<WebClient | undefined> =>
      import("./src/exports.ts").then(({ webClient }) => webClient()),

    /**
     * Answer a click on a button this feature did not post. Async only
     * because the module is imported dynamically like the rest of `exports`;
     * the registration itself is synchronous and needs no running surface.
     */
    onButton: (
      actionId: string,
      handler: SlackButtonHandler
    ): Promise<void> =>
      import("./src/exports.ts").then(({ onButton }) =>
        onButton(actionId, handler)
      ),
  },
  routes: {
    /** Public, and signature-checked by Bolt rather than by the loopback guard. */
    "POST /slack/events": (request): Answer =>
      withRuntime((runtime) => runtime.handleEventsRequest(request)),

    /**
     * The operator's page. Loopback-guarded like the skill routes: the daemon
     * is reachable from the internet because `POST /slack/events` has to be,
     * and this lists thread ids and participants.
     */
    "GET /slack/dashboard": loopbackEntry((runtime, request) =>
      runtime.handleDashboardRequest(request)
    ),

    /** The same page saving one field; the handler branches on the method. */
    "POST /slack/dashboard": loopbackEntry((runtime, request) =>
      runtime.handleDashboardRequest(request)
    ),

    /** Holds the response until someone answers — what makes the skill blocking. */
    "POST /slack/thread/ask": loopbackEntry((runtime, request) =>
      runtime.handleAskRequest(request)
    ),

    /** Moves a live session onto a new thread; never starts one. */
    "POST /slack/thread/carry": loopbackEntry((runtime, request) =>
      runtime.handleCarryRequest(request)
    ),

    "POST /slack/thread/attach": loopbackEntry((runtime, request) =>
      runtime.handleAttachRequest(request)
    ),

    "POST /slack/thread/chart": loopbackEntry((runtime, request) =>
      runtime.handleChartRequest(request)
    ),

    /** Starts arbitrary agent turns, so the guard matters most here. */
    "POST /slack/thread/dispatch": loopbackEntry((runtime, request) =>
      runtime.handleDispatchRequest(request)
    ),

    "POST /slack/thread/image": loopbackEntry((runtime, request) =>
      runtime.handleImageRequest(request)
    ),

    /** Posts the form and returns; the turn ENDS and the answers start a new one. */
    "POST /slack/thread/questions": loopbackEntry((runtime, request) =>
      runtime.handleQuestionsRequest(request)
    ),
  },
} satisfies ApiContribution;
