import { describe, expect, test } from "#src/test-support/effect-test.ts";
import { Result } from "effect";

import type { WebClient } from "@slack/web-api";

import {
  appendDedupedMessages,
  capStateAfterPage,
  fetchChannelHistory,
  historyPageArgs,
  type GetHistoryOpts,
} from "./get-history.ts";

type HistoryArgs = Parameters<WebClient["conversations"]["history"]>[0];

interface HistoryPage {
  readonly messages?: readonly unknown[];
  readonly response_metadata?: {
    readonly next_cursor?: string;
  };
}

interface FakeClient {
  readonly calls: HistoryArgs[];
  readonly client: WebClient;
}

const fakeHistoryClient = (pages: readonly HistoryPage[]): FakeClient => {
  const calls: HistoryArgs[] = [];
  let served = 0;
  const narrow = {
    conversations: {
      history: (args: HistoryArgs): Promise<HistoryPage> => {
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

interface HistoryPayload {
  readonly hasMore: boolean;
  readonly messages: readonly unknown[];
}

const isHistoryPayload = (value: unknown): value is HistoryPayload => {
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

const payloadOf = (result: Result.Result<unknown, Error>): HistoryPayload => {
  if (Result.isFailure(result)) {
    throw new Error(`expected a page, got a failure: ${result.failure.message}`);
  }
  if (!isHistoryPayload(result.success)) {
    throw new Error(
      `expected { messages, hasMore }, got ${JSON.stringify(result.success)}`
    );
  }
  return result.success;
};

const run = async (
  opts: Omit<GetHistoryOpts, "channel" | "env"> & {
    readonly client: WebClient;
  }
): Promise<HistoryPayload> =>
  payloadOf(
    await fetchChannelHistory({
      channel: "C1",
      env: {},
      ...opts,
    })
  );

const stamped = (from: number, count: number): { readonly ts: string }[] =>
  Array.from({ length: count }, (_, index) => ({
    ts: String(from + index),
  }));

const endlessPages = (count: number, perPage: number): HistoryPage[] =>
  Array.from({ length: count }, (_, index) => ({
    messages: stamped(index * perPage, perPage),
    response_metadata: {
      next_cursor: `c${index + 1}`,
    },
  }));

const BASE = {
  channel: "C1",
} as const;

describe("historyPageArgs", () => {
  test("asks for a full page and sends nothing it was not given", () => {
    expect(
      historyPageArgs({
        collected: 0,
        cursor: undefined,
        maxTotal: 1000,
        opts: BASE,
      })
    ).toEqual({
      channel: "C1",
      limit: 200,
    });
  });

  test("re-sends the window on page 2, because the cursor does not carry it", () => {
    expect(
      historyPageArgs({
        collected: 200,
        cursor: "c1",
        maxTotal: 1000,
        opts: {
          channel: "C1",
          latest: "1700.9",
          oldest: "1600.1",
        },
      })
    ).toEqual({
      channel: "C1",
      cursor: "c1",
      inclusive: true,
      latest: "1700.9",
      limit: 200,
      oldest: "1600.1",
    });
  });

  test("shrinks the last request to the messages still owed", () => {
    expect(
      historyPageArgs({
        collected: 200,
        cursor: "c1",
        maxTotal: 250,
        opts: BASE,
      }).limit
    ).toBe(50);
  });

  test("never asks Slack for zero messages", () => {
    expect(
      historyPageArgs({
        collected: 200,
        cursor: "c1",
        maxTotal: 200,
        opts: BASE,
      }).limit
    ).toBe(1);
  });

  test("asks for a full page in unlimited mode", () => {
    expect(
      historyPageArgs({
        collected: 4000,
        cursor: "c1",
        maxTotal: 0,
        opts: BASE,
      }).limit
    ).toBe(200);
  });
});

describe("appendDedupedMessages", () => {
  test("keeps the first copy of a ts and drops the repeat", () => {
    const seen = new Set<string>();
    const messages: unknown[] = [];

    appendDedupedMessages(seen, messages, [
      { text: "first", ts: "1" },
      { text: "second", ts: "2" },
    ]);
    appendDedupedMessages(seen, messages, [
      { text: "repeat", ts: "2" },
      { text: "third", ts: "3" },
    ]);

    expect(messages).toEqual([
      { text: "first", ts: "1" },
      { text: "second", ts: "2" },
      { text: "third", ts: "3" },
    ]);
  });

  test("drops an entry with no usable ts rather than passing it through", () => {
    const messages: unknown[] = [];

    appendDedupedMessages(new Set<string>(), messages, [
      { text: "no ts" },
      { text: "numeric ts", ts: 1 },
      null,
      { text: "kept", ts: "1" },
    ]);

    expect(messages).toEqual([{ text: "kept", ts: "1" }]);
  });
});

describe("capStateAfterPage", () => {
  test("keeps going below an explicit limit", () => {
    expect(capStateAfterPage(1000, 200)).toBe("continue");
  });

  test("is done once the explicit limit is met or passed", () => {
    expect(capStateAfterPage(1000, 1000)).toBe("done");
    expect(capStateAfterPage(1000, 1200)).toBe("done");
  });

  test("keeps going in unlimited mode until the safety cap", () => {
    expect(capStateAfterPage(0, 9999)).toBe("continue");
  });

  test("reports capped, not done, when unlimited mode hits 10k", () => {
    expect(capStateAfterPage(0, 10_000)).toBe("capped");
  });
});

describe("fetchChannelHistory", () => {
  test("threads the cursor from one page into the next", async () => {
    const fake = fakeHistoryClient([
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

    const page = await run({
      client: fake.client,
      limit: 10,
    });

    expect(fake.calls).toEqual([
      { channel: "C1", limit: 10 },
      { channel: "C1", cursor: "c1", limit: 8 },
    ]);
    expect(page.messages).toEqual([{ ts: "1" }, { ts: "2" }, { ts: "3" }]);
    expect(page.hasMore).toBe(false);
  });

  test("does not repeat a message Slack sent on both pages", async () => {
    const fake = fakeHistoryClient([
      {
        messages: [{ ts: "1" }, { ts: "2" }],
        response_metadata: {
          next_cursor: "c1",
        },
      },
      {
        messages: [{ ts: "2" }, { ts: "3" }],
      },
    ]);

    const page = await run({
      client: fake.client,
      limit: 10,
    });

    expect(page.messages).toEqual([{ ts: "1" }, { ts: "2" }, { ts: "3" }]);
  });

  test("re-sends the oldest/latest window on every page", async () => {
    const fake = fakeHistoryClient([
      {
        messages: [{ ts: "1650" }],
        response_metadata: {
          next_cursor: "c1",
        },
      },
      {
        messages: [{ ts: "1660" }],
      },
    ]);

    await fetchChannelHistory({
      channel: "C1",
      client: fake.client,
      env: {},
      latest: "1700.9",
      limit: 10,
      oldest: "1600.1",
    });

    expect(fake.calls).toEqual([
      {
        channel: "C1",
        inclusive: true,
        latest: "1700.9",
        limit: 10,
        oldest: "1600.1",
      },
      {
        channel: "C1",
        cursor: "c1",
        inclusive: true,
        latest: "1700.9",
        limit: 9,
        oldest: "1600.1",
      },
    ]);
  });

  test("stops on the empty next_cursor Slack sends for a last page", async () => {
    const fake = fakeHistoryClient([
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

    const page = await run({
      client: fake.client,
      limit: 10,
    });

    expect(fake.calls).toHaveLength(1);
    expect(page.hasMore).toBe(false);
  });

  test("collects 1000 messages when no limit was given", async () => {
    const fake = fakeHistoryClient(endlessPages(10, 200));

    const page = await run({
      client: fake.client,
    });

    expect(page.messages).toHaveLength(1000);
    expect(fake.calls).toHaveLength(5);
    expect(fake.calls.at(-1)).toEqual({
      channel: "C1",
      cursor: "c4",
      limit: 200,
    });
    expect(page.hasMore).toBe(true);
  });

  test("caps limit 0 at 10k and reports the truncation", async () => {
    const fake = fakeHistoryClient(endlessPages(60, 200));

    const page = await run({
      client: fake.client,
      limit: 0,
    });

    expect(page.messages).toHaveLength(10_000);
    expect(fake.calls).toHaveLength(50);
    expect(page.hasMore).toBe(true);
  });

  test("truncates to the limit and reports Slack still had pages", async () => {
    const fake = fakeHistoryClient([
      {
        messages: [{ ts: "1" }, { ts: "2" }, { ts: "3" }],
        response_metadata: {
          next_cursor: "c1",
        },
      },
    ]);

    const page = await run({
      client: fake.client,
      limit: 2,
    });

    expect(page.messages).toEqual([{ ts: "1" }, { ts: "2" }]);
    expect(page.hasMore).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  test("reports hasMore false when the channel ran out first", async () => {
    const fake = fakeHistoryClient([
      {
        messages: [{ ts: "1" }],
      },
    ]);

    expect(
      await run({
        client: fake.client,
        limit: 10,
      })
    ).toEqual({
      hasMore: false,
      messages: [{ ts: "1" }],
    });
  });

  test("still fails on the missing token when no client is injected", async () => {
    const result = await fetchChannelHistory({
      channel: "C1",
      env: {},
    });

    expect(Result.isFailure(result)).toBe(true);
    expect(Result.isFailure(result) && result.failure.message).toContain(
      "SLACK_BOT_TOKEN"
    );
  });
});
