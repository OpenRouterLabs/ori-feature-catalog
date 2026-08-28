import net from "node:net";

import { WebClient } from "@slack/web-api";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { makeBoltApp } from "./bolt-lifecycle.ts";
import { makeConfiguredWebClient } from "./client-live.ts";
import { resolveSlackProxyAgent } from "./proxy-agent.ts";

const PLACEHOLDER = "__slack_bot_token__";

const startConnectProxy = async (): Promise<{
  readonly requestLines: string[];
  readonly stop: () => void;
  readonly url: string;
}> => {
  const requestLines: string[] = [];
  const server = net.createServer((socket) => {
    socket.once("data", (chunk: Buffer) => {
      requestLines.push(chunk.toString("utf8").split("\r\n")[0] ?? "");
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("proxy stub did not bind a TCP port");
  }
  return {
    requestLines,
    stop: () => {
      server.close();
    },
    url: `http://ori:proxy-token@127.0.0.1:${address.port}`,
  };
};

describe("resolveSlackProxyAgent", () => {
  test("returns nothing when no proxy is configured", () => {
    expect(resolveSlackProxyAgent({})).toBeUndefined();
  });

  test("reads either spelling of the proxy variable", () => {
    expect(
      resolveSlackProxyAgent({ HTTPS_PROXY: "http://127.0.0.1:1" })
    ).toBeDefined();
    expect(
      resolveSlackProxyAgent({ https_proxy: "http://127.0.0.1:1" })
    ).toBeDefined();
  });

  test("ignores a blank proxy value", () => {
    expect(resolveSlackProxyAgent({ HTTPS_PROXY: "   " })).toBeUndefined();
  });

  test("honours NO_PROXY for slack.com, its subdomains, and the wildcard", () => {
    const proxy = "http://127.0.0.1:1";
    for (const noProxy of ["slack.com", ".slack.com", "*", "a.com,slack.com"]) {
      expect(
        resolveSlackProxyAgent({ HTTPS_PROXY: proxy, NO_PROXY: noProxy })
      ).toBeUndefined();
    }
  });

  test("keeps the proxy when NO_PROXY names a different host", () => {
    expect(
      resolveSlackProxyAgent({
        HTTPS_PROXY: "http://127.0.0.1:1",
        NO_PROXY: "example.com",
      })
    ).toBeDefined();
  });
});

describe("makeConfiguredWebClient", () => {
  test("sends Slack traffic through the sidecar when HTTPS_PROXY is set", async () => {
    const proxy = await startConnectProxy();
    try {
      const client = makeConfiguredWebClient(PLACEHOLDER, {
        HTTPS_PROXY: proxy.url,
      });
      /* Not awaited: the stub answers 502 and the client's bounded retry
         policy would outlive the test. The first CONNECT is the assertion. */
      void client.auth.test().catch(() => undefined);
      for (let wait = 0; wait < 100 && proxy.requestLines.length === 0; wait++) {
        await Bun.sleep(20);
      }
      expect(proxy.requestLines[0]).toContain("CONNECT slack.com:443");
    } finally {
      proxy.stop();
    }
  });

  test("carries the token as an Authorization header, not the SDK's own", () => {
    const client = makeConfiguredWebClient(PLACEHOLDER, {});
    expect(client).toBeInstanceOf(WebClient);
    expect(client.token).toBeUndefined();
  });
});

describe("makeBoltApp", () => {
  test("routes Bolt's OWN client through the sidecar", async () => {
    /*
     * The regression this guards: Bolt builds its own WebClient and runs the
     * authorization `auth.test` on it. Proxying only our client leaves that
     * call direct, it answers `invalid_auth` against the placeholder token,
     * and every incoming event is refused before a listener runs.
     */
    const proxy = await startConnectProxy();
    try {
      makeBoltApp({
        env: { HTTPS_PROXY: proxy.url },
        logger: { error() {}, info() {}, warn() {} },
        signingSecret: "secret",
        token: PLACEHOLDER,
      });
      for (let wait = 0; wait < 100 && proxy.requestLines.length === 0; wait++) {
        await Bun.sleep(20);
      }
      expect(proxy.requestLines[0]).toContain("CONNECT slack.com:443");
    } finally {
      proxy.stop();
    }
  });
});
