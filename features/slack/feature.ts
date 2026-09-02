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

import { isLoopback } from "./src/turn/routes/dispatch.ts";

const HTTP_FORBIDDEN = 403;
const HTTP_SERVICE_UNAVAILABLE = 503;

type Answer = Promise<Response> | Response;

type StartRuntime = (bridge: Chat) => Promise<SlackRuntime>;

const hostEnv = (): Readonly<Record<string, string | undefined>> => process.env;

const startFromModule: StartRuntime = async (bridge) => {
  const { startSlackRuntime } = await import("./src/index.ts");
  return startSlackRuntime({ bridge, env: hostEnv(), logger: console });
};

export const makeSlackFeature = (start: StartRuntime = startFromModule) => {
  let active: SlackRuntime | undefined;

  const withRuntime = (reach: (runtime: SlackRuntime) => Answer): Answer =>
    active === undefined
      ? Response.json(
          { error: "slack chat surface is not running" },
          { status: HTTP_SERVICE_UNAVAILABLE }
        )
      : reach(active);

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

  const chat: ChatContribution = {
    name: "slack",

    async start(bridge: Chat) {
      active = await start(bridge);
    },

    async stop() {
      await active?.stop();
      active = undefined;
    },
  };

  const api = {
    exports: {
      postMessage: (
        input: SlackPostMessageInput
      ): Promise<SlackPostMessageResult> =>
        import("./src/exports.ts").then(({ makePostMessage, postMessage }) =>
          active === undefined
            ? postMessage(input, hostEnv())
            : makePostMessage(active.slack)(input)
        ),

      webClient: (): Promise<WebClient | undefined> =>
        active === undefined
          ? import("./src/exports.ts").then(({ webClient }) =>
              webClient(hostEnv())
            )
          : Promise.resolve(active.slack.raw),

      onButton: (
        actionId: string,
        handler: SlackButtonHandler
      ): Promise<void> =>
        import("./src/exports.ts").then(({ onButton }) =>
          onButton(actionId, handler)
        ),
    },
    routes: {
      "POST /slack/events": (request): Answer =>
        withRuntime((runtime) => runtime.handleEventsRequest(request)),

      "GET /slack/dashboard": loopbackEntry((runtime, request) =>
        runtime.handleDashboardRequest(request)
      ),

      "POST /slack/dashboard": loopbackEntry((runtime, request) =>
        runtime.handleDashboardRequest(request)
      ),

      "POST /slack/thread/ask": loopbackEntry((runtime, request) =>
        runtime.handleAskRequest(request)
      ),

      "POST /slack/thread/carry": loopbackEntry((runtime, request) =>
        runtime.handleCarryRequest(request)
      ),

      "POST /slack/thread/attach": loopbackEntry((runtime, request) =>
        runtime.handleAttachRequest(request)
      ),

      "POST /slack/thread/chart": loopbackEntry((runtime, request) =>
        runtime.handleChartRequest(request)
      ),

      "POST /slack/thread/dispatch": loopbackEntry((runtime, request) =>
        runtime.handleDispatchRequest(request)
      ),

      "POST /slack/thread/image": loopbackEntry((runtime, request) =>
        runtime.handleImageRequest(request)
      ),

      "POST /slack/thread/questions": loopbackEntry((runtime, request) =>
        runtime.handleQuestionsRequest(request)
      ),
    },
  } satisfies ApiContribution;

  return { api, chat };
};

export const { api, chat } = makeSlackFeature();
