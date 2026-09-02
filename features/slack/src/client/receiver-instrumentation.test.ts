/* oxlint-disable typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/max-lines-per-function eslint/require-await unicorn/consistent-function-scoping -- test doubles stand in for Slack SDK shapes and record `unknown` log fields; cases read better whole than split */
import type { App, ReceiverEvent } from "@slack/bolt";

import { afterEach, describe, expect, test } from "#src/test-support/effect-test.ts";
import { createHmac } from "node:crypto";

import { SlackReceiver } from "./receiver.ts";

const SIGNING_SECRET = "test-signing-secret";

interface Logged {
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

interface Recorder {
  readonly lines: Logged[];
  readonly logger: {
    readonly error: (message: string, ...rest: readonly unknown[]) => void;
    readonly info: (message: string, ...rest: readonly unknown[]) => void;
    readonly warn: (message: string, ...rest: readonly unknown[]) => void;
  };
}

const recorder = (): Recorder => {
  const lines: Logged[] = [];
  return {
    lines,
    logger: {
      error: () => {},
      info: (message: string, ...rest: readonly unknown[]) => {
        lines.push({
          fields: (rest[0] ?? {}) as Record<string, unknown>,
          message,
        });
      },
      warn: () => {},
    },
  };
};

const receipts = (recorded: Recorder): Logged[] =>
  recorded.lines.filter((line) => line.message === "[slack] event received");

const sign = (body: string, timestamp: number): string =>
  `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;

const request = (input: {
  body: string;
  signature?: string;
  timestamp?: number;
  retryNum?: string;
  retryReason?: string;
}): Request => {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("x-slack-request-timestamp", String(timestamp));
  headers.set("x-slack-signature", input.signature ?? sign(input.body, timestamp));
  if (input.retryNum !== undefined) {
    headers.set("x-slack-retry-num", input.retryNum);
  }
  if (input.retryReason !== undefined) {
    headers.set("x-slack-retry-reason", input.retryReason);
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

const started: SlackReceiver[] = [];

const startedReceiver = async (
  processEvent: (event: ReceiverEvent) => Promise<void> = async () => {}
): Promise<{
  readonly recorded: Recorder;
  readonly receiver: SlackReceiver;
}> => {
  const recorded = recorder();
  const receiver = new SlackReceiver({
    logger: recorded.logger,
    signingSecret: SIGNING_SECRET,
  });
  receiver.init({ processEvent } as unknown as App);
  await receiver.start();
  started.push(receiver);
  return {
    recorded,
    receiver,
  };
};

afterEach(async () => {
  await Promise.all(started.splice(0).map((r) => r.stop()));
});

describe("the receipt line", () => {
  test("a delivered event is measured from receipt to the answer Slack gets", async () => {
    const { recorded, receiver } = await startedReceiver();

    const response = await receiver.handleRequest(
      request({ body: eventBody("Ev-ack") })
    );

    expect(receipts(recorded)).toHaveLength(1);
    expect(receipts(recorded)[0]?.fields).toMatchObject({
      deduped: false,
      event_id: "Ev-ack",
      event_type: "app_mention",
      outcome: "dispatched",
      status: response.status,
    });
    expect(typeof receipts(recorded)[0]?.fields.ack_ms).toBe("number");
  });

  test("the dedupe branch still emits, marked as the duplicate it dropped", async () => {
    const { recorded, receiver } = await startedReceiver();
    const body = eventBody("Ev-dup");

    await receiver.handleRequest(request({ body }));
    await receiver.handleRequest(request({ body, retryNum: "1" }));

    expect(receipts(recorded)).toHaveLength(2);
    expect(receipts(recorded)[0]?.fields.deduped).toBe(false);
    expect(receipts(recorded)[1]?.fields).toMatchObject({
      deduped: true,
      event_id: "Ev-dup",
      outcome: "deduped",
    });
  });

  test("Slack's retry metadata is recorded rather than thrown away", async () => {
    const { recorded, receiver } = await startedReceiver();

    await receiver.handleRequest(
      request({
        body: eventBody("Ev-retry"),
        retryNum: "2",
        retryReason: "http_timeout",
      })
    );

    expect(receipts(recorded)[0]?.fields).toMatchObject({
      retry_num: 2,
      retry_reason: "http_timeout",
    });
  });

  test("a first delivery carries no retry fields", async () => {
    const { recorded, receiver } = await startedReceiver();

    await receiver.handleRequest(request({ body: eventBody("Ev-first") }));

    expect(receipts(recorded)[0]?.fields.retry_num).toBeUndefined();
    expect(receipts(recorded)[0]?.fields.retry_reason).toBeUndefined();
  });

  test("an event that never reaches a listener still says so", async () => {
    const recorded = recorder();
    const receiver = new SlackReceiver({
      logger: recorded.logger,
      signingSecret: SIGNING_SECRET,
    });

    const response = await receiver.handleRequest(
      request({ body: eventBody("Ev-dead") })
    );

    expect(response.status).toBe(503);
    expect(receipts(recorded)).toHaveLength(1);
    expect(receipts(recorded)[0]?.fields).toMatchObject({
      outcome: "not_started",
      status: 503,
    });
  });

  test("a listener that throws is named as the reason, and Slack is still acked", async () => {
    const { recorded, receiver } = await startedReceiver(() =>
      Promise.reject(new Error("listener exploded"))
    );

    const response = await receiver.handleRequest(
      request({ body: eventBody("Ev-boom") })
    );

    expect(response.status).toBe(200);
    expect(receipts(recorded)[0]?.fields).toMatchObject({
      event_id: "Ev-boom",
      outcome: "listener_failed",
      status: 200,
    });
  });

  test("an unverified request is counted without inventing an event id", async () => {
    const { recorded, receiver } = await startedReceiver();

    await receiver.handleRequest(
      request({
        body: eventBody("Ev-forged"),
        signature: "v0=deadbeef",
      })
    );

    expect(receipts(recorded)).toHaveLength(1);
    expect(receipts(recorded)[0]?.fields).toMatchObject({
      outcome: "unverified",
      status: 401,
    });
    expect(receipts(recorded)[0]?.fields.event_id).toBeUndefined();
  });

  test("exactly one line is emitted per inbound request", async () => {
    const { recorded, receiver } = await startedReceiver();

    await receiver.handleRequest(request({ body: eventBody("Ev1") }));
    await receiver.handleRequest(request({ body: eventBody("Ev2") }));
    await receiver.handleRequest(request({ body: "not json and not a form" }));

    expect(receipts(recorded)).toHaveLength(3);
    expect(receipts(recorded)[2]?.fields.outcome).toBe("unparseable");
  });

  test("a request whose body cannot be read still emits, and still fails loudly", async () => {
    const { recorded, receiver } = await startedReceiver();
    const spent = request({ body: eventBody("Ev-unreadable") });
    await spent.text();

    await expect(receiver.handleRequest(spent)).rejects.toThrow();

    expect(receipts(recorded)).toHaveLength(1);
    expect(receipts(recorded)[0]?.fields.outcome).toBe("errored");
    expect(receipts(recorded)[0]?.fields.status).toBeUndefined();
  });

  test("no user, channel, thread or message text is carried as a field", async () => {
    const { recorded, receiver } = await startedReceiver();

    await receiver.handleRequest(
      request({ body: eventBody("Ev-tags", "a secret sentence") })
    );

    const rendered = JSON.stringify(receipts(recorded)[0]?.fields);
    expect(rendered).not.toContain("a secret sentence");
    expect(rendered).not.toContain("C1");
    expect(rendered).not.toContain("U1");
    expect(rendered).not.toContain("1.1");
  });
});

describe("the receipt clock", () => {
  test("an admitted event's receipt is readable while its turn is dispatching", async () => {
    let seenAt: number | undefined;
    const { receiver } = await startedReceiver(async () => {
      seenAt = receiver.receiptAt("Ev-clock");
    });

    await receiver.handleRequest(request({ body: eventBody("Ev-clock") }));

    expect(typeof seenAt).toBe("number");
  });

  test("an event the receiver never admitted has no receipt", async () => {
    const { receiver } = await startedReceiver();

    expect(receiver.receiptAt("Ev-never")).toBeUndefined();
  });

  test("stop() forgets the receipts along with the dedupe memory", async () => {
    const { receiver } = await startedReceiver();

    await receiver.handleRequest(request({ body: eventBody("Ev-gone") }));
    await receiver.stop();

    expect(receiver.receiptAt("Ev-gone")).toBeUndefined();
  });
});
