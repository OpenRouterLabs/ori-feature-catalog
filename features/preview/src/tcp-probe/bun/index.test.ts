import { Effect } from "effect";

import { bunTcpProbe } from "./index.ts";
import { describe, expect, it } from "../../effect-bun-test.ts";

const listenOn = (hostname: string, port: number) =>
  Bun.listen({ hostname, port, socket: { data: () => undefined } });

describe("bunTcpProbe.get", () => {
  it.effect("reads the status and body straight off the socket", () =>
    Effect.gen(function* () {
      const server = Bun.serve({
        hostname: "::1",
        port: 0,
        idleTimeout: 0,
        fetch: () => new Response("<h1>ready</h1>", { status: 200 }),
      });
      const response = yield* bunTcpProbe.get(`http://[::1]:${server.port}/`);
      server.stop(true);
      expect(response.status).toBe(200);
      expect(response.body).toContain("<h1>ready</h1>");
    })
  );

  it.effect(
    "fails for a port nothing listens on, never taking a proxy's answer for the dev server as a proxied fetch once did",
    () =>
      Effect.gen(function* () {
        const closed = listenOn("::1", 0);
        const port = closed.port;
        closed.stop(true);
        const failure = yield* bunTcpProbe
          .get(`http://[::1]:${port}/`)
          .pipe(Effect.flip);
        expect(failure.message).toContain("nothing listening");
      })
  );
});

describe("bunTcpProbe.isPortFree", () => {
  it.effect("calls a port free when nothing holds it on either loopback", () =>
    Effect.gen(function* () {
      const probe = listenOn("127.0.0.1", 0);
      const port = probe.port;
      probe.stop(true);
      expect(yield* bunTcpProbe.isPortFree(port)).toBe(true);
    })
  );

  it.effect("calls a port taken when something listens on IPv4 loopback", () =>
    Effect.gen(function* () {
      const listener = listenOn("127.0.0.1", 0);
      const free = yield* bunTcpProbe.isPortFree(listener.port);
      listener.stop(true);
      expect(free).toBe(false);
    })
  );

  it.effect(
    "calls a port taken when something holds it on IPv6 loopback only, which an IPv4 check alone would miss",
    () =>
      Effect.gen(function* () {
        const listener = listenOn("::1", 0);
        const free = yield* bunTcpProbe.isPortFree(listener.port);
        listener.stop(true);
        expect(free).toBe(false);
      })
  );
});
