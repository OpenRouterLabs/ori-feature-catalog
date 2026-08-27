/* oxlint-disable typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/max-lines-per-function eslint/require-await eslint/no-unsafe-optional-chaining typescript/no-invalid-void-type promise/avoid-new promise/param-names unicorn/consistent-function-scoping -- test doubles assert on recorded `unknown` args and stand in for Slack SDK shapes; cases read better whole than split */
import type { WebClient } from "@slack/web-api";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { makeFakeSlackClient } from "./client/client-test-support.ts";
import { makePostMessage, postMessage, webClient } from "./exports.ts";

const withRaw = (
  postMessageStub: (args: never) => unknown
): ReturnType<typeof makeFakeSlackClient> =>
  makeFakeSlackClient({}, { "chat.postMessage": postMessageStub });

describe("makePostMessage", () => {
  test("returns channel and ts on success", async () => {
    const fake = withRaw(() => ({
      channel: "C1",
      ok: true,
      ts: "1700.1",
    }));

    await expect(
      makePostMessage(fake.shape)({
        channel: "C1",
        text: "hi",
      })
    ).resolves.toEqual({
      channel: "C1",
      ok: true,
      ts: "1700.1",
    });
  });

  test("trims text Slack would reject outright", async () => {
    // Slack rejects an over-long message rather than trimming it, so an
    // uncapped caller gets a hard failure where a trimmed post would do.
    const sent: Record<string, unknown>[] = [];
    const fake = withRaw(((args: Record<string, unknown>) => {
      sent.push(args);
      return {
        channel: "C1",
        ok: true,
      };
    }) as never);

    await makePostMessage(fake.shape)({
      channel: "C1",
      text: "x".repeat(60_000),
    });

    const text = String(sent[0]?.text);
    expect(text.length).toBeLessThanOrEqual(39_000);
    expect(text).toContain("truncated");
  });

  test("caps blocks at what Slack accepts", async () => {
    const sent: Record<string, unknown>[] = [];
    const fake = withRaw(((args: Record<string, unknown>) => {
      sent.push(args);
      return {
        channel: "C1",
        ok: true,
      };
    }) as never);

    await makePostMessage(fake.shape)({
      blocks: Array.from({ length: 120 }, () => ({
        text: {
          text: "b",
          type: "mrkdwn" as const,
        },
        type: "section" as const,
      })),
      channel: "C1",
      text: "hi",
    });

    expect((sent[0]?.blocks as unknown[]).length).toBeLessThanOrEqual(50);
  });

  test("reports a Slack failure as a result rather than throwing", async () => {
    // A feature posting a courtesy notification must not have its own work
    // fail because Slack was rate limited.
    const fake = withRaw(() => {
      throw new Error("ratelimited");
    });

    const result = await makePostMessage(fake.shape)({
      channel: "C1",
      text: "hi",
    });

    expect(result).toEqual({
      error: "ratelimited",
      ok: false,
    });
  });

  test("defaults unfurling off so a posted link does not expand", async () => {
    const fake = withRaw(() => ({
      channel: "C1",
      ok: true,
      ts: "1",
    }));

    await makePostMessage(fake.shape)({
      channel: "C1",
      text: "see a link",
    });

    expect(fake.calls[0]?.args).toMatchObject({
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  test("honours explicit unfurl opt-in", async () => {
    const fake = withRaw(() => ({
      channel: "C1",
      ok: true,
      ts: "1",
    }));

    await makePostMessage(fake.shape)({
      channel: "C1",
      text: "x",
      unfurlLinks: true,
      unfurlMedia: true,
    });

    expect(fake.calls[0]?.args).toMatchObject({
      unfurl_links: true,
      unfurl_media: true,
    });
  });

  test("omits thread_ts entirely for a top-level post", async () => {
    // Sending `thread_ts: undefined` is not the same as omitting it.
    const fake = withRaw(() => ({
      channel: "C1",
      ok: true,
      ts: "1",
    }));

    await makePostMessage(fake.shape)({
      channel: "C1",
      text: "x",
    });

    expect(Object.keys(fake.calls[0]?.args as object)).not.toContain(
      "thread_ts"
    );
  });

  test("threads a reply when asked", async () => {
    const fake = withRaw(() => ({
      channel: "C1",
      ok: true,
      ts: "1",
    }));

    await makePostMessage(fake.shape)({
      channel: "C1",
      text: "x",
      threadTs: "1700.0001",
    });

    expect(fake.calls[0]?.args).toMatchObject({ thread_ts: "1700.0001" });
  });

  test("passes Block Kit through", async () => {
    const fake = withRaw(() => ({
      channel: "C1",
      ok: true,
      ts: "1",
    }));
    const blocks = [{ type: "section" }] as never;

    await makePostMessage(fake.shape)({
      blocks,
      channel: "C1",
      text: "x",
    });

    expect((fake.calls[0]?.args as { blocks?: unknown[] }).blocks).toEqual([
      { type: "section" },
    ]);
  });

  test("falls back to the requested channel when Slack omits it", async () => {
    const fake = withRaw(() => ({ ok: true }));

    await expect(
      makePostMessage(fake.shape)({
        channel: "C_REQUESTED",
        text: "x",
      })
    ).resolves.toMatchObject({
      channel: "C_REQUESTED",
      ok: true,
    });
  });
});

describe("postMessage", () => {
  test("reports a missing token as a result, not a throw", async () => {
    const original = Bun.env.SLACK_BOT_TOKEN;
    delete Bun.env.SLACK_BOT_TOKEN;

    try {
      const result = await postMessage({
        channel: "C1",
        text: "hi",
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toContain("SLACK_BOT_TOKEN");
    } finally {
      if (original !== undefined) {
        Bun.env.SLACK_BOT_TOKEN = original;
      }
    }
  });
});

describe("webClient", () => {
  test("is undefined rather than a throw when no token is in scope", () => {
    // Reachable from any feature in any process, including a workspace that
    // never configured Slack. An exception out of an accessor would fail a
    // caller that was only checking whether Slack was available at all.
    const original = Bun.env.SLACK_BOT_TOKEN;
    delete Bun.env.SLACK_BOT_TOKEN;

    try {
      expect(webClient()).toBeUndefined();
    } finally {
      if (original !== undefined) {
        Bun.env.SLACK_BOT_TOKEN = original;
      }
    }
  });

  test("hands every caller the same instance", () => {
    // The SDK's rate-limit queue is per WebClient. A fresh one per consumer
    // would let two features stampede the same channel while each believed
    // it was within the limit.
    const original = Bun.env.SLACK_BOT_TOKEN;
    Bun.env.SLACK_BOT_TOKEN = "xoxb-test-token";

    try {
      expect(webClient()).toBe(webClient());
    } finally {
      if (original === undefined) {
        delete Bun.env.SLACK_BOT_TOKEN;
      } else {
        Bun.env.SLACK_BOT_TOKEN = original;
      }
    }
  });
});

describe("one client, whoever asks", () => {
  const withRunningSurface = <A>(slack: unknown, run: () => A): A => {
    const before = globalThis.__oriSlackRuntime;
    globalThis.__oriSlackRuntime = { slack } as typeof before;
    try {
      return run();
    } finally {
      globalThis.__oriSlackRuntime = before;
    }
  };

  test("hands back the surface's own client while it is running", () => {
    // The Slack SDK's rate-limit queue is per client instance, so building a
    // second one meant a process running the surface held two queues that
    // could not see each other — each polite alone, Slack seeing the sum.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an identity stub: the test asserts which object comes back, never calls it
    const raw = { marker: "the surface's" } as unknown as WebClient;

    const got = withRunningSurface({ raw }, () => webClient());

    expect(got).toBe(raw);
  });

  test("falls back to its own when no surface is running", () => {
    // The independence that makes this reachable from a schedule or an API
    // route in a process that never booted Slack.
    const original = Bun.env.SLACK_BOT_TOKEN;
    Bun.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    const before = globalThis.__oriSlackRuntime;
    globalThis.__oriSlackRuntime = undefined;

    try {
      const first = webClient();
      expect(first).toBeDefined();
      expect(first).toBe(webClient());
    } finally {
      globalThis.__oriSlackRuntime = before;
      if (original === undefined) {
        delete Bun.env.SLACK_BOT_TOKEN;
      } else {
        Bun.env.SLACK_BOT_TOKEN = original;
      }
    }
  });
});
