import { describe, expect, test } from "#src/test-support/index.ts";
import { Result, Schema } from "effect";

import type { WebClient } from "@slack/web-api";

import { opaqueSchema } from "#src/schema-support.ts";
import { getThreadReplies, type GetRepliesOpts } from "./get-replies.ts";

type RepliesArgs = Parameters<WebClient["conversations"]["replies"]>[0];

const RepliesPageSchema = Schema.Struct({
  messages: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  response_metadata: Schema.optionalKey(
    Schema.Struct({
      next_cursor: Schema.optionalKey(Schema.String),
    })
  ),
});

type RepliesPage = typeof RepliesPageSchema.Type;

const FakeClientSchema = Schema.Struct({
  calls: Schema.mutable(
    Schema.Array(opaqueSchema<RepliesArgs>("FakeClient.calls"))
  ),
  client: opaqueSchema<WebClient>("FakeClient.client"),
});

type FakeClient = typeof FakeClientSchema.Type;

const fakeRepliesClient = (pages: readonly RepliesPage[]): FakeClient => {
  const calls: RepliesArgs[] = [];
  let served = 0;
  const narrow = {
    conversations: {
      replies: (args: RepliesArgs): Promise<RepliesPage> => {
        calls.push(args);
        const page = pages[served] ?? {};
        served += 1;
        return Promise.resolve(page);
      },
    },
  };
  return {
    calls,
    client: narrow as unknown as WebClient,
  };
};

const RepliesPayloadSchema = Schema.Struct({
  hasMore: Schema.Boolean,
  messages: Schema.Array(Schema.Unknown),
});

type RepliesPayload = typeof RepliesPayloadSchema.Type;

const isRepliesPayload = (value: unknown): value is RepliesPayload => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    "messages" in value &&
    Array.isArray(value.messages) &&
    "hasMore" in value &&
    typeof value.hasMore === "boolean"
  );
};

const payloadOf = (result: Result.Result<unknown, Error>): RepliesPayload => {
  if (Result.isFailure(result)) {
    throw new Error(
      `expected a thread, got a failure: ${result.failure.message}`
    );
  }
  if (!isRepliesPayload(result.success)) {
    throw new Error(
      `expected { messages, hasMore }, got ${JSON.stringify(result.success)}`
    );
  }
  return result.success;
};

const run = async (
  opts: Omit<GetRepliesOpts, "channel" | "env" | "ts"> & {
    readonly client: WebClient;
  }
): Promise<RepliesPayload> =>
  payloadOf(
    await getThreadReplies({
      channel: "C1",
      env: {},
      ts: "1700.1",
      ...opts,
    })
  );

const stamped = (from: number, count: number): { readonly ts: string }[] =>
  Array.from({ length: count }, (_, index) => ({
    ts: String(from + index),
  }));

describe("getThreadReplies", () => {
  test("names the thread on page 1 and threads the cursor onto page 2", async () => {
    const fake = fakeRepliesClient([
      {
        messages: [{ ts: "1" }, { ts: "2" }],
        response_metadata: {
          next_cursor: "c1",
        },
      },
      {
        messages: [{ ts: "3" }],
      },
    ]);

    const thread = await run({
      client: fake.client,
      limit: 10,
    });

    expect(fake.calls).toEqual([
      {
        channel: "C1",
        inclusive: true,
        limit: 10,
        ts: "1700.1",
      },
      {
        channel: "C1",
        cursor: "c1",
        inclusive: true,
        limit: 8,
        ts: "1700.1",
      },
    ]);
    expect(thread.messages).toEqual([{ ts: "1" }, { ts: "2" }, { ts: "3" }]);
    expect(thread.hasMore).toBe(false);
  });

  test("keeps a message repeated across pages, unlike history", async () => {
    const fake = fakeRepliesClient([
      {
        messages: [{ ts: "1" }, { ts: "2" }],
        response_metadata: {
          next_cursor: "c1",
        },
      },
      {
        messages: [{ ts: "2" }],
      },
    ]);

    const thread = await run({
      client: fake.client,
      limit: 10,
    });

    expect(thread.messages).toEqual([{ ts: "1" }, { ts: "2" }, { ts: "2" }]);
  });

  test("truncates at the cap and reports that Slack had more", async () => {
    const fake = fakeRepliesClient([
      {
        messages: [{ ts: "1" }, { ts: "2" }, { ts: "3" }],
        response_metadata: {
          next_cursor: "c1",
        },
      },
    ]);

    const thread = await run({
      client: fake.client,
      limit: 2,
    });

    expect(thread.messages).toEqual([{ ts: "1" }, { ts: "2" }]);
    expect(thread.hasMore).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  test("reports hasMore false when the cap lands on the end of the thread", async () => {
    const fake = fakeRepliesClient([
      {
        messages: [{ ts: "1" }, { ts: "2" }],
      },
    ]);

    const thread = await run({
      client: fake.client,
      limit: 2,
    });

    expect(thread).toEqual({
      hasMore: false,
      messages: [{ ts: "1" }, { ts: "2" }],
    });
    expect(fake.calls).toHaveLength(1);
  });

  test("stops on the empty next_cursor Slack sends for a last page", async () => {
    const fake = fakeRepliesClient([
      {
        messages: [{ ts: "1" }],
        response_metadata: {
          next_cursor: "",
        },
      },
      {
        messages: [{ ts: "2" }],
      },
    ]);

    const thread = await run({
      client: fake.client,
      limit: 10,
    });

    expect(fake.calls).toHaveLength(1);
    expect(thread.hasMore).toBe(false);
  });

  test("asks for 50 messages when no limit was given", async () => {
    const fake = fakeRepliesClient([
      {
        messages: [{ ts: "1" }],
      },
    ]);

    await run({
      client: fake.client,
    });

    expect(fake.calls[0]?.limit).toBe(50);
  });

  test("never asks for more than 200 in a single request", async () => {
    const fake = fakeRepliesClient([
      {
        messages: stamped(0, 200),
        response_metadata: {
          next_cursor: "c1",
        },
      },
      {
        messages: stamped(200, 200),
        response_metadata: {
          next_cursor: "c2",
        },
      },
      {
        messages: stamped(400, 100),
      },
    ]);

    const thread = await run({
      client: fake.client,
      limit: 500,
    });

    expect(fake.calls.map((call) => call?.limit)).toEqual([200, 200, 100]);
    expect(thread.messages).toHaveLength(500);
    expect(thread.hasMore).toBe(false);
  });

  test("treats limit 0 as one message, not as unlimited", async () => {
    const fake = fakeRepliesClient([
      {
        messages: [{ ts: "1" }, { ts: "2" }, { ts: "3" }],
        response_metadata: {
          next_cursor: "c1",
        },
      },
    ]);

    const thread = await run({
      client: fake.client,
      limit: 0,
    });

    expect(fake.calls[0]?.limit).toBe(1);
    expect(thread.messages).toEqual([{ ts: "1" }]);
    expect(thread.hasMore).toBe(true);
  });

  test("still fails on the missing token when no client is injected", async () => {
    const result = await getThreadReplies({
      channel: "C1",
      env: {},
      ts: "1700.1",
    });

    expect(Result.isFailure(result)).toBe(true);
    expect(Result.isFailure(result) && result.failure.message).toContain(
      "SLACK_BOT_TOKEN"
    );
  });
});