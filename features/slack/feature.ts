/**
 * feature.ts — the Slack chat surface's contribution entry.
 *
 * Registered as `slack` so this workspace feature shadows the framework
 * builtin. The runtime is imported dynamically: the catalog registers every
 * chat surface in every ori process, and an eager import would pull Bolt into
 * TUI sessions that never select it.
 *
 * The handle lives on `globalThis` because the eager module and the dynamic
 * `import()` resolve as two module graphs — a module-local `let` exists twice,
 * so `start` writes one copy while the route handler reads another and every
 * request answers 503 while boot reports the surface live.
 */

import type { WebClient } from "@slack/web-api";
import type {
  ApiContribution,
  ApiRouteHandler,
  Chat,
  ChatContribution,
} from "ori";

import type {
  SlackPostMessageInput,
  SlackPostMessageResult,
} from "./src/exports.ts";
import type { SlackRuntime } from "./src/index.ts";

import { isLoopback } from "./src/turn/routes/dispatch.ts";

const HTTP_FORBIDDEN = 403;
const HTTP_SERVICE_UNAVAILABLE = 503;

declare global {
  // oxlint-disable-next-line no-var -- required for global augmentation
  var __oriSlackRuntime: SlackRuntime | undefined;
}

type Answer = Promise<Response> | Response;

const withRuntime = (reach: (runtime: SlackRuntime) => Answer): Answer =>
  globalThis.__oriSlackRuntime === undefined
    ? Response.json(
        { error: "slack chat surface is not running" },
        { status: HTTP_SERVICE_UNAVAILABLE }
      )
    : reach(globalThis.__oriSlackRuntime);

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

export const chat: ChatContribution = {
  name: "slack",

  async start(bridge: Chat) {
    const { startSlackRuntime } = await import("./src/index.ts");
    globalThis.__oriSlackRuntime = await startSlackRuntime({
      bridge,
      logger: console,
    });
  },

  async stop() {
    await globalThis.__oriSlackRuntime?.stop();
    globalThis.__oriSlackRuntime = undefined;
  },
};

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
  },
  routes: {
    /** Public, and signature-checked by Bolt rather than by the loopback guard. */
    "POST /slack/events": (request): Answer =>
      withRuntime((runtime) => runtime.handleEventsRequest(request)),

    /** Holds the response until someone answers — what makes the skill blocking. */
    "POST /slack/thread/ask": loopbackEntry((runtime, request) =>
      runtime.handleAskRequest(request)
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
