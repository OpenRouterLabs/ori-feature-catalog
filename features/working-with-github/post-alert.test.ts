import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { POST_ALERT_TIMEOUT_MS, postAlert } from "./post-alert.ts";

interface Received {
  readonly path: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

const fakeSlack = (answers: readonly (() => Response | undefined)[]) => {
  const received: Received[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      received.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      const answer = answers[received.length - 1] ?? answers.at(-1);
      return answer?.() ?? new Promise<Response>(() => undefined);
    },
  });
  return {
    received,
    url: `http://127.0.0.1:${server.port}/api/`,
    stop: () => server.stop(true),
  };
};

const ok = () => Response.json({ ok: true, ts: "1.2" });

let savedToken: string | undefined;

beforeEach(() => {
  // oxlint-disable-next-line node/no-process-env -- postAlert reads SLACK_BOT_TOKEN from the process environment.
  savedToken = process.env.SLACK_BOT_TOKEN;
  // oxlint-disable-next-line node/no-process-env -- postAlert reads SLACK_BOT_TOKEN from the process environment.
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
});

afterEach(() => {
  // oxlint-disable-next-line node/no-process-env -- restoring the variable the test set.
  process.env.SLACK_BOT_TOKEN = savedToken;
});

describe("postAlert", () => {
  test("posts one chat.postMessage with the bot token and no unfurls", async () => {
    const slack = fakeSlack([ok]);
    try {
      await postAlert({ channel: "C123", text: "GitHub access is broken" }, { slackApiUrl: slack.url });
      expect(slack.received).toEqual([
        {
          path: "/api/chat.postMessage",
          authorization: "Bearer xoxb-test",
          body: { channel: "C123", text: "GitHub access is broken", unfurl_links: false, unfurl_media: false },
        },
      ]);
    } finally {
      slack.stop();
    }
  });

  test("rejects before any request when SLACK_BOT_TOKEN is unset", async () => {
    // oxlint-disable-next-line node/no-process-env -- the case under test is an unset token.
    delete process.env.SLACK_BOT_TOKEN;
    const slack = fakeSlack([ok]);
    try {
      await expect(postAlert({ channel: "C123", text: "x" }, { slackApiUrl: slack.url })).rejects.toThrow(
        "SLACK_BOT_TOKEN is not set"
      );
      expect(slack.received).toHaveLength(0);
    } finally {
      slack.stop();
    }
  });

  test("a non-ok platform result is Slack's final answer and is not retried", async () => {
    const slack = fakeSlack([() => Response.json({ ok: false, error: "invalid_auth" })]);
    try {
      await expect(postAlert({ channel: "C123", text: "x" }, { slackApiUrl: slack.url })).rejects.toThrow(
        "Slack chat.postMessage failed: invalid_auth"
      );
      expect(slack.received).toHaveLength(1);
    } finally {
      slack.stop();
    }
  });

  test("a 5xx and a rate limit are retried, honouring Retry-After", async () => {
    const slack = fakeSlack([
      () => new Response("unavailable", { status: 503 }),
      () => new Response("slow down", { status: 429, headers: { "retry-after": "0.01" } }),
      ok,
    ]);
    try {
      await postAlert({ channel: "C123", text: "x" }, { slackApiUrl: slack.url });
      expect(slack.received).toHaveLength(3);
    } finally {
      slack.stop();
    }
  });

  test("a rate limit longer than the post waits ends it at once instead of retrying inside the window", async () => {
    const slack = fakeSlack([() => new Response("slow down", { status: 429, headers: { "retry-after": "120" } }), ok]);
    try {
      await expect(postAlert({ channel: "C123", text: "x" }, { slackApiUrl: slack.url })).rejects.toThrow(
        "Slack asked to wait 120s"
      );
      expect(slack.received).toHaveLength(1);
    } finally {
      slack.stop();
    }
  });

  test("an accepted post whose reply cannot be read is not retried, since the alert may have been posted", async () => {
    const slack = fakeSlack([() => new Response("not json", { status: 200 }), ok]);
    try {
      await expect(postAlert({ channel: "C123", text: "x" }, { slackApiUrl: slack.url })).rejects.toThrow(
        "the alert may have been posted"
      );
      expect(slack.received).toHaveLength(1);
    } finally {
      slack.stop();
    }
  });

  test("gives up after three retries", async () => {
    const slack = fakeSlack([() => new Response("unavailable", { status: 503 })]);
    try {
      await expect(postAlert({ channel: "C123", text: "x" }, { slackApiUrl: slack.url })).rejects.toThrow(
        "answered HTTP 503"
      );
      expect(slack.received).toHaveLength(4);
    } finally {
      slack.stop();
    }
  });

  test("a wedged slack.com settles as a timeout failure on every attempt instead of hanging", async () => {
    const slack = fakeSlack([() => undefined]);
    try {
      await expect(
        postAlert({ channel: "C123", text: "x" }, { slackApiUrl: slack.url, requestTimeoutMs: 50 })
      ).rejects.toThrow(/request failed: .*(timed out|abort)/iu);
      expect(slack.received).toHaveLength(4);
    } finally {
      slack.stop();
    }
  });

  test("the production per-attempt deadline is finite and covers a retried attempt", () => {
    expect(Number.isFinite(POST_ALERT_TIMEOUT_MS)).toBe(true);
    expect(POST_ALERT_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
  });
});
