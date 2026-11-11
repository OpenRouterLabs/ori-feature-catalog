import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { POST_ALERT_TIMEOUT_MS, postAlert, readSlackBotToken } from "./post-alert.ts";

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

  test("a whitespace-only SLACK_BOT_TOKEN is unset too: it rejects before any request", async () => {
    for (const blank of ["   ", "\n", " \t "]) {
      // oxlint-disable-next-line node/no-process-env -- the case under test is a blank token.
      process.env.SLACK_BOT_TOKEN = blank;
      const slack = fakeSlack([() => Response.json({ ok: false, error: "not_authed" })]);
      try {
        await expect(postAlert({ channel: "C123", text: "x" }, { slackApiUrl: slack.url })).rejects.toThrow(
          "SLACK_BOT_TOKEN is not set"
        );
        expect(slack.received).toHaveLength(0);
      } finally {
        slack.stop();
      }
    }
  });

  test("readSlackBotToken trims a padded token and reads a blank one as unset", () => {
    expect(readSlackBotToken({ SLACK_BOT_TOKEN: " xoxb-test\n" })).toBe("xoxb-test");
    expect(readSlackBotToken({ SLACK_BOT_TOKEN: " \t " })).toBeUndefined();
    expect(readSlackBotToken({ SLACK_BOT_TOKEN: "" })).toBeUndefined();
    expect(readSlackBotToken({})).toBeUndefined();
  });

  test("readSlackBotToken unquotes an env-file value, so the quotes never reach Bearer", () => {
    expect(readSlackBotToken({ SLACK_BOT_TOKEN: '"xoxb-test"' })).toBe("xoxb-test");
    expect(readSlackBotToken({ SLACK_BOT_TOKEN: "'xoxb-test'" })).toBe("xoxb-test");
    expect(readSlackBotToken({ SLACK_BOT_TOKEN: '""' })).toBeUndefined();
  });

  test("a quoted SLACK_BOT_TOKEN posts with the bare token", async () => {
    // oxlint-disable-next-line node/no-process-env -- postAlert reads SLACK_BOT_TOKEN from the process environment.
    process.env.SLACK_BOT_TOKEN = '"xoxb-test"';
    const slack = fakeSlack([ok]);
    try {
      await postAlert({ channel: "C123", text: "x" }, { slackApiUrl: slack.url });
      expect(slack.received[0]?.authorization).toBe("Bearer xoxb-test");
    } finally {
      slack.stop();
    }
  });

  test("the gh-auth-health schedule guards both alert paths with readSlackBotToken, never a raw env read", () => {
    const schedule = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "schedules", "gh-auth-health", "schedule.ts"),
      "utf-8"
    );
    expect(schedule).not.toContain("process.env.SLACK_BOT_TOKEN");
    expect([...schedule.matchAll(/if \(readSlackBotToken\(\) === undefined\)/gu)]).toHaveLength(2);
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

  test("a refused post (a 4xx) names its HTTP status and never claims Slack accepted it", async () => {
    for (const [answer, expected] of [
      [() => new Response("<html>Forbidden</html>", { status: 403, headers: { "content-type": "text/html" } }), "answered HTTP 403"],
      [() => new Response("Not Found", { status: 404 }), "answered HTTP 404"],
      [() => Response.json({ message: "proxy authentication required" }, { status: 407 }), "answered HTTP 407"],
      [() => Response.json({ ok: false, error: "invalid_arguments" }, { status: 400 }), "answered HTTP 400: invalid_arguments"],
    ] as const) {
      const slack = fakeSlack([answer, ok]);
      try {
        const failure = await postAlert({ channel: "C123", text: "x" }, { slackApiUrl: slack.url }).then(
          () => undefined,
          (error: unknown) => (error instanceof Error ? error.message : String(error))
        );
        expect(failure).toBe(`Slack chat.postMessage ${expected}`);
        expect(slack.received).toHaveLength(1);
      } finally {
        slack.stop();
      }
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
