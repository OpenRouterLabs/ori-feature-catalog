import { Effect, Layer, Option } from "effect";

import { judgeResponse, waitForHttp } from "#src/readiness/index.ts";
import { bunTcpProbeLayer } from "#src/tcp-probe/bun/index.ts";
import { fetchHttpClientLayer } from "#src/http.ts";
import {
  describe,
  expect,
  it,
  test,
} from "#src/effect-bun-test.ts";

describe("judgeResponse", () => {
  it("accepts a page that rendered", () => {
    expect(
      judgeResponse({ status: 200, body: "<html><h1>Dashboard</h1></html>" })
    ).toEqual(Option.none());
  });

  it("rejects a server error, because a 500 page is not a preview of anything", () => {
    expect(judgeResponse({ status: 500, body: "" })).toEqual(
      Option.some("the page answered HTTP 500")
    );
  });

  test.each([
    {
      framework: "Vite",
      body: "<vite-error-overlay></vite-error-overlay>",
      marker: "vite-error-overlay",
    },
    {
      framework: "Next.js",
      body: "<h1>Unhandled Runtime Error</h1>",
      marker: "Unhandled Runtime Error",
    },
    {
      framework: "webpack",
      body: "<h1>Failed to compile</h1>",
      marker: "Failed to compile",
    },
  ])(
    "rejects a 200 that carries the $framework error overlay, since dev servers answer 200 with the overlay",
    ({ body, marker }) => {
      expect(judgeResponse({ status: 200, body })).toEqual(
        Option.some(`the page shows a framework error (${marker})`)
      );
    }
  );

  it("accepts a healthy Next.js dev page, whose markup always carries the nextjs-portal element", () => {
    expect(
      judgeResponse({
        status: 200,
        body: "<main>ok</main><nextjs-portal></nextjs-portal>",
      })
    ).toEqual(Option.none());
  });

  it("accepts a 404 on the ready path, because many apps only serve their real routes", () => {
    expect(judgeResponse({ status: 404, body: "Not found" })).toEqual(
      Option.none()
    );
  });
});

describe("waitForHttp", () => {
  it.effect(
    "finds a dev server that bound localhost to IPv6 only, as Vite does in the runtime image",
    () =>
      Effect.gen(function* () {
        const server = Bun.serve({
          hostname: "::1",
          port: 0,
          idleTimeout: 0,
          fetch: () => new Response("<h1>ready</h1>"),
        });
        const port = server.port;
        const response = yield* waitForHttp(
          [`http://127.0.0.1:${port}/`, `http://[::1]:${port}/`],
          Effect.succeed(true)
        );
        server.stop(true);
        expect(response.url).toBe(`http://[::1]:${port}/`);
        expect(response.status).toBe(200);
      }).pipe(
        Effect.provide(Layer.merge(fetchHttpClientLayer, bunTcpProbeLayer))
      )
  );
});

describe("waitForHttp with two loopbacks", () => {
  it.effect(
    "prefers the loopback serving a healthy page over one serving an error",
    () =>
      Effect.gen(function* () {
        const broken = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          idleTimeout: 0,
          fetch: () => new Response("oops", { status: 500 }),
        });
        const port = broken.port ?? 0;
        const healthy = Bun.serve({
          hostname: "::1",
          port,
          idleTimeout: 0,
          fetch: () => new Response("<h1>ready</h1>"),
        });
        const response = yield* waitForHttp(
          [`http://127.0.0.1:${port}/`, `http://[::1]:${port}/`],
          Effect.succeed(true)
        );
        broken.stop(true);
        healthy.stop(true);
        expect(response.url).toBe(`http://[::1]:${port}/`);
      }).pipe(Effect.provide(bunTcpProbeLayer))
  );
});

describe("waitForHttp during a slow first compile", () => {
  it.live(
    "keeps waiting through an early error page instead of treating it as the answer",
    () =>
      Effect.gen(function* () {
        let requests = 0;
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          idleTimeout: 0,
          fetch: () => {
            requests += 1;
            return requests < 2
              ? new Response("compiling", { status: 500 })
              : new Response("<h1>ready</h1>");
          },
        });
        const port = server.port ?? 0;
        const response = yield* waitForHttp(
          [`http://127.0.0.1:${port}/`],
          Effect.succeed(true)
        );
        server.stop(true);
        expect(response.status).toBe(200);
      }).pipe(Effect.provide(bunTcpProbeLayer))
  );
});
