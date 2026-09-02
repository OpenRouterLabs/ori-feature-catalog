/* oxlint-disable typescript/explicit-function-return-type typescript/no-unsafe-type-assertion vitest/prefer-each -- a route-table double: the context stub carries only the two fields the handlers read, and the per-route cases are generated from one table so each route gets its own named test */
/**
 * feature.test.ts — every runtime handler is reachable over HTTP.
 *
 * `SlackRuntime` and the route table are edited in two different files, so a
 * handler can be built, exported and never registered. That is exactly how
 * `POST /slack/thread/ask` went missing: the skill posted to it, the runtime
 * exposed `handleAskRequest`, and the daemon answered 404 — silently, because a
 * blocked agent cannot tell a missing route from a reader who never replied.
 *
 * Asserting the two sides against each other means adding a handler without a
 * route (or a route without its loopback guard) fails here instead of in a
 * thread.
 */

import type { WebClient } from "@slack/web-api";
import type { ApiRouteContext, Chat } from "ori";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import type { SlackRuntime } from "./src/index.ts";

import { api, makeSlackFeature } from "./feature.ts";

const HTTP_FORBIDDEN = 403;
const HTTP_SERVICE_UNAVAILABLE = 503;

/** The public webhook is signature-checked by Bolt, not by the loopback guard. */
const PUBLIC_ROUTE = "POST /slack/events";

/** Each loopback route and the runtime handler it must call. */
const LOOPBACK_ROUTES = {
  "GET /slack/dashboard": "handleDashboardRequest",
  // Same handler as the GET: one page, and it branches on the method.
  "POST /slack/dashboard": "handleDashboardRequest",
  "POST /slack/thread/ask": "handleAskRequest",
  "POST /slack/thread/carry": "handleCarryRequest",
  "POST /slack/thread/attach": "handleAttachRequest",
  "POST /slack/thread/chart": "handleChartRequest",
  "POST /slack/thread/dispatch": "handleDispatchRequest",
  "POST /slack/thread/image": "handleImageRequest",
  "POST /slack/thread/questions": "handleQuestionsRequest",
} as const satisfies Record<string, keyof SlackRuntime>;

const routes = api.routes as Record<
  string,
  (request: Request, context: ApiRouteContext) => Promise<Response> | Response
>;

const contextFrom = (remoteAddress: string | undefined): ApiRouteContext =>
  ({
    logger: {
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: () => {},
    },
    remoteAddress,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the two fields the handlers read are needed
  }) as unknown as ApiRouteContext;

/**
 * A request for a `"METHOD /path"` key. The method is read off the key rather
 * than assumed: the dashboard is a GET, and a GET carrying a JSON body is not
 * a request any client would actually send.
 */
const requestFor = (key: string): Request => {
  const [method = "POST", path = "/"] = key.split(" ");
  const url = `http://127.0.0.1${path}`;
  return method === "GET"
    ? new Request(url)
    : new Request(url, {
        body: "{}",
        headers: { "content-type": "application/json" },
        method,
      });
};

/** Install a runtime that only records which handler was called. */
const withRuntime = async (
  route: string,
  remoteAddress: string | undefined
): Promise<{ called: string | undefined; response: Response }> => {
  let called: string | undefined;
  const handler = (name: string) => (): Promise<Response> => {
    called = name;
    return Promise.resolve(new Response("ok"));
  };

  const runtime = {
    handleAskRequest: handler("handleAskRequest"),
    handleCarryRequest: handler("handleCarryRequest"),
    handleAttachRequest: handler("handleAttachRequest"),
    handleChartRequest: handler("handleChartRequest"),
    handleDashboardRequest: handler("handleDashboardRequest"),
    handleDispatchRequest: handler("handleDispatchRequest"),
    handleEventsRequest: handler("handleEventsRequest"),
    handleImageRequest: handler("handleImageRequest"),
    handleQuestionsRequest: handler("handleQuestionsRequest"),
    // Only the routes are under test here; the client the surface publishes
    // for `use("slack")` is exercised in exports.test.ts.
    slack: undefined as unknown as SlackRuntime["slack"],
    stop: () => Promise.resolve(),
  };

  const feature = makeSlackFeature(() => Promise.resolve(runtime));
  await feature.chat.start(undefined as unknown as Chat);

  const started = feature.api.routes as Record<
    string,
    (request: Request, context: ApiRouteContext) => Promise<Response> | Response
  >;

  try {
    const response = await started[route](
      requestFor(route),
      contextFrom(remoteAddress)
    );
    return {
      called,
      response,
    };
  } finally {
    await feature.chat.stop();
  }
};

describe("slack route table", () => {
  test("registers a route for every skill entry point", () => {
    expect(Object.keys(routes).toSorted()).toEqual(
      [PUBLIC_ROUTE, ...Object.keys(LOOPBACK_ROUTES)].toSorted()
    );
  });

  for (const [route, expected] of Object.entries(LOOPBACK_ROUTES)) {
    test(`${route} calls ${expected} from loopback`, async () => {
      const { called, response } = await withRuntime(route, "127.0.0.1");
      expect(called).toBe(expected);
      expect(response.ok).toBe(true);
    });

    test(`${route} rejects a non-loopback caller`, async () => {
      const { called, response } = await withRuntime(route, "203.0.113.7");
      expect(called).toBeUndefined();
      expect(response.status).toBe(HTTP_FORBIDDEN);
    });

    test(`${route} answers 503 before the surface is up`, async () => {
      const response = await routes[route](
        requestFor(route),
        contextFrom("127.0.0.1")
      );
      expect(response.status).toBe(HTTP_SERVICE_UNAVAILABLE);
    });
  }

  test("a rejection names the route it rejected", async () => {
    // The five entries shared one guard, so the warning can no longer carry a
    // per-route literal — it reads the path off the request instead. That is
    // the only thing telling an operator WHICH route someone probed, so it is
    // worth an assertion rather than an assumption.
    const warned: { fields: unknown; message: string }[] = [];
    const context = {
      logger: {
        debug: () => {},
        error: () => {},
        info: () => {},
        warn: (message: string, fields?: unknown) => {
          warned.push({
            fields,
            message,
          });
        },
      },
      remoteAddress: "203.0.113.7",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the two fields the handlers read are needed
    } as unknown as ApiRouteContext;

    await routes["POST /slack/thread/dispatch"](
      requestFor("POST /slack/thread/dispatch"),
      context
    );

    expect(warned).toHaveLength(1);
    expect(warned[0]?.fields).toMatchObject({
      path: "/slack/thread/dispatch",
      remoteAddress: "203.0.113.7",
    });
  });

  test("the public webhook is not loopback-guarded", async () => {
    const { called } = await withRuntime(PUBLIC_ROUTE, "203.0.113.7");
    expect(called).toBe("handleEventsRequest");
  });
});

describe('the use("slack") surface', () => {
  test("offers the primitive as well as the convenience", () => {
    // `FeatureApis.slack` is typed by the framework SDK, which ships the
    // builtin's shape, so a member dropped here does not fail at any call
    // site — it resolves to undefined at run time. This is the only place
    // that notices.
    expect(Object.keys(api.exports).toSorted()).toEqual([
      "onButton",
      "postMessage",
      "webClient",
    ]);
  });

  test("hands back the surface's own client while it is running", async () => {
    const raw = { marker: "the surface's" } as unknown as WebClient;
    const runtime = {
      slack: { raw },
      stop: () => Promise.resolve(),
    } as unknown as SlackRuntime;

    const feature = makeSlackFeature(() => Promise.resolve(runtime));
    await feature.chat.start(undefined as unknown as Chat);

    try {
      expect(await feature.api.exports.webClient()).toBe(raw);
    } finally {
      await feature.chat.stop();
    }
  });
});
