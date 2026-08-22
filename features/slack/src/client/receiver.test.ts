/* oxlint-disable typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/max-lines-per-function eslint/require-await eslint/no-unsafe-optional-chaining typescript/no-invalid-void-type promise/avoid-new promise/param-names unicorn/consistent-function-scoping -- test doubles assert on recorded `unknown` args and stand in for Slack SDK shapes; cases read better whole than split */
import type { App, ReceiverEvent } from "@slack/bolt";

import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { SlackReceiver } from "./receiver.ts";

const SIGNING_SECRET = "test-signing-secret";

const silentLogger = {
  error: () => {},
  warn: () => {},
};

/** Sign exactly as Slack does: v0:timestamp:rawBody, HMAC-SHA256. */
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

/** A receiver wired to a fake App that records what Bolt would have seen. */
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
  // The prune timer would otherwise keep the test process alive.
  await Promise.all(started.splice(0).map((r) => r.stop()));
});

describe("signature verification", () => {
  test("accepts a correctly signed request", async () => {
    const { receiver, seen } = await startedReceiver();
    const body = eventBody("Ev1");

    const response = await receiver.handleRequest(request({ body }));

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  test("rejects a tampered body without dispatching", async () => {
    const { receiver, seen } = await startedReceiver();
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = sign(eventBody("Ev1"), timestamp);

    // Same signature, different body — the exact-bytes property.
    const response = await receiver.handleRequest(
      request({
        body: eventBody("Ev1", "tampered"),
        signature,
        timestamp,
      })
    );

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test("rejects a wrong signature", async () => {
    const { receiver, seen } = await startedReceiver();

    const response = await receiver.handleRequest(
      request({
        body: eventBody("Ev1"),
        signature: "v0=deadbeef",
      })
    );

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test("rejects a stale timestamp outside Slack's replay window", async () => {
    const { receiver, seen } = await startedReceiver();
    const body = eventBody("Ev1");
    // Six minutes old — beyond the five-minute window.
    const timestamp = Math.floor(Date.now() / 1000) - 360;

    const response = await receiver.handleRequest(
      request({
        body,
        timestamp,
      })
    );

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test("rejects when the signature headers are missing entirely", async () => {
    const { receiver, seen } = await startedReceiver();

    const response = await receiver.handleRequest(
      request({
        body: eventBody("Ev1"),
        omitHeaders: true,
      })
    );

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });
});

describe("url verification", () => {
  test("echoes the challenge and never reaches Bolt", async () => {
    const { receiver, seen } = await startedReceiver();
    const body = JSON.stringify({
      challenge: "abc123",
      type: "url_verification",
    });

    const response = await receiver.handleRequest(request({ body }));

    expect(await response.json()).toEqual({ challenge: "abc123" });
    expect(seen).toHaveLength(0);
  });

  test("an unsigned challenge is still rejected", async () => {
    const { receiver } = await startedReceiver();
    const body = JSON.stringify({
      challenge: "abc123",
      type: "url_verification",
    });

    const response = await receiver.handleRequest(
      request({
        body,
        signature: "v0=nope",
      })
    );

    expect(response.status).toBe(401);
  });
});
