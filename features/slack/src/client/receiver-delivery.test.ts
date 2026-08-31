/* oxlint-disable typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/max-lines-per-function eslint/require-await eslint/no-unsafe-optional-chaining typescript/no-invalid-void-type promise/avoid-new promise/param-names unicorn/consistent-function-scoping -- test doubles assert on recorded `unknown` args and stand in for Slack SDK shapes; cases read better whole than split */
import type { App, ReceiverEvent } from "@slack/bolt";

import { afterEach, describe, expect, test } from "#src/test-support/effect-test.ts";
import { createHmac } from "node:crypto";

import { SlackReceiver } from "./receiver.ts";

const SIGNING_SECRET = "test-signing-secret";

const silentLogger = {
  error: () => {},
  warn: () => {},
};

const sign = (body: string, timestamp: number): string =>
  `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;

const request = (input: {
  body: string;
  contentType?: string;
  signature?: string;
  timestamp?: number;
  omitHeaders?: boolean;
  retryNum?: string;
}): Request => {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const headers = new Headers({
    "content-type": input.contentType ?? "application/json",
  });
  if (input.omitHeaders !== true) {
    headers.set("x-slack-request-timestamp", String(timestamp));
    headers.set(
      "x-slack-signature",
      input.signature ?? sign(input.body, timestamp)
    );
  }
  if (input.retryNum !== undefined) {
    headers.set("x-slack-retry-num", input.retryNum);
  }
  return new Request("https://example.test/slack/events", {
    body: input.body,
    headers,
    method: "POST",
  });
};

const eventBody = (eventId: string, text = "hi"): string =>
  JSON.stringify({
    event: {
      channel: "C1",
      text,
      ts: "1.1",
      type: "app_mention",
      user: "U1",
    },
    event_id: eventId,
    team_id: "T1",
    type: "event_callback",
  });

const makeReceiver = (): {
  readonly receiver: SlackReceiver;
  readonly seen: ReceiverEvent[];
} => {
  const seen: ReceiverEvent[] = [];
  const receiver = new SlackReceiver({
    logger: silentLogger,
    signingSecret: SIGNING_SECRET,
  });
  receiver.init({
    processEvent: async (event: ReceiverEvent) => {
      seen.push(event);
    },
  } as unknown as App);
  return {
    receiver,
    seen,
  };
};

const started: SlackReceiver[] = [];
const startedReceiver = async (): Promise<ReturnType<typeof makeReceiver>> => {
  const made = makeReceiver();
  await made.receiver.start();
  started.push(made.receiver);
  return made;
};

afterEach(async () => {
  await Promise.all(started.splice(0).map((r) => r.stop()));
});

describe("deduplication", () => {
  test("a Slack retry of the same event dispatches only once", async () => {
    const { receiver, seen } = await startedReceiver();
    const body = eventBody("Ev-dup");

    const first = await receiver.handleRequest(request({ body }));
    const retry = await receiver.handleRequest(
      request({
        body,
        retryNum: "1",
      })
    );

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  test("distinct events both dispatch", async () => {
    const { receiver, seen } = await startedReceiver();

    await receiver.handleRequest(request({ body: eventBody("Ev1") }));
    await receiver.handleRequest(request({ body: eventBody("Ev2") }));

    expect(seen).toHaveLength(2);
  });

  test("an event with no id is admitted rather than dropped", async () => {
    const { receiver, seen } = await startedReceiver();
    const body = JSON.stringify({ type: "event_callback" });

    await receiver.handleRequest(request({ body }));
    await receiver.handleRequest(request({ body }));

    expect(seen).toHaveLength(2);
  });

  test("a failed dispatch lets Slack retry rather than losing the message", async () => {
    const seen: ReceiverEvent[] = [];
    let attempts = 0;
    const receiver = new SlackReceiver({
      logger: silentLogger,
      signingSecret: SIGNING_SECRET,
    });
    receiver.init({
      processEvent: (event: ReceiverEvent) => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(new Error("transient"));
        }
        seen.push(event);
        return Promise.resolve();
      },
    } as unknown as App);
    await receiver.start();
    started.push(receiver);

    const body = eventBody("Ev-retry");
    await receiver.handleRequest(request({ body }));
    await receiver.handleRequest(
      request({
        body,
        retryNum: "1",
      })
    );

    expect(attempts).toBe(2);
    expect(seen).toHaveLength(1);
  });

  test("stop() clears the dedup memory", async () => {
    const { receiver, seen } = await startedReceiver();
    const body = eventBody("Ev-dup");

    await receiver.handleRequest(request({ body }));
    await receiver.stop();
    receiver.init({
      processEvent: async (event: ReceiverEvent) => {
        seen.push(event);
      },
    } as unknown as App);
    await receiver.start();
    started.push(receiver);
    await receiver.handleRequest(request({ body }));

    expect(seen).toHaveLength(2);
  });
});

describe("payload handling", () => {
  test("parses a form-encoded interactivity payload", async () => {
    const { receiver, seen } = await startedReceiver();
    const payload = JSON.stringify({
      actions: [
        {
          action_id: "a1",
          value: "v",
        },
      ],
      type: "block_actions",
    });
    const body = new URLSearchParams({ payload }).toString();

    const response = await receiver.handleRequest(
      request({
        body,
        contentType: "application/x-www-form-urlencoded",
      })
    );

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect((seen[0]?.body as { type?: string }).type).toBe("block_actions");
  });

  test("rejects an unparseable body", async () => {
    const { receiver, seen } = await startedReceiver();

    const response = await receiver.handleRequest(
      request({ body: "not json and not a payload form" })
    );

    expect(response.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  test("rejects an oversized body before parsing it", async () => {
    const { receiver, seen } = await startedReceiver();

    const response = await receiver.handleRequest(
      request({ body: "x".repeat(1_000_001) })
    );

    expect(response.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  test("forwards Slack's retry metadata to Bolt middleware", async () => {
    const { receiver, seen } = await startedReceiver();

    await receiver.handleRequest(
      request({
        body: eventBody("Ev1"),
        retryNum: "2",
      })
    );

    expect(seen[0]?.retryNum).toBe(2);
  });
});

describe("lifecycle", () => {
  test("answers 503 before init, without throwing", async () => {
    const receiver = new SlackReceiver({
      logger: silentLogger,
      signingSecret: SIGNING_SECRET,
    });

    const response = await receiver.handleRequest(
      request({ body: eventBody("Ev1") })
    );

    expect(response.status).toBe(503);
  });

  test("a stopped receiver refuses new events so Slack redelivers them", async () => {
    let processed = 0;
    const receiver = new SlackReceiver({
      logger: silentLogger,
      signingSecret: SIGNING_SECRET,
    });
    receiver.init({
      processEvent: () => {
        processed += 1;
        return Promise.resolve();
      },
    } as unknown as App);
    await receiver.start();
    await receiver.stop();

    const response = await receiver.handleRequest(
      request({ body: eventBody("Ev1") })
    );

    expect(response.status).toBe(503);
    expect(processed).toBe(0);
  });

  test("a throwing listener still acknowledges Slack", async () => {
    const receiver = new SlackReceiver({
      logger: silentLogger,
      signingSecret: SIGNING_SECRET,
    });
    receiver.init({
      processEvent: () => Promise.reject(new Error("listener exploded")),
    } as unknown as App);
    await receiver.start();
    started.push(receiver);

    const response = await receiver.handleRequest(
      request({ body: eventBody("Ev1") })
    );

    expect(response.status).toBe(200);
  });
});
