/* oxlint-disable typescript/no-unsafe-type-assertion unicorn/no-useless-undefined unicorn/no-array-sort -- the Bolt stand-in narrows App deliberately, and an explicit undefined is what a payload without that field carries */
import type { App } from "@slack/bolt";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import type {
  RawAssistantThreadStarted,
  RawSlackMessage,
} from "./listeners.ts";

import { registerListeners } from "./listeners.ts";

type Handler = (args: {
  readonly body?: unknown;
  readonly event?: unknown;
  readonly message?: unknown;
}) => Promise<void>;

interface Logged {
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

interface Recorded {
  readonly assistantContexts: RawAssistantThreadStarted[];
  readonly assistantStarts: RawAssistantThreadStarted[];
  readonly events: Map<string, Handler>;
  readonly lines: Logged[];
  readonly messages: Handler[];
  readonly turns: RawSlackMessage[];
}

const harness = (
  receiptAt: (eventId: string) => number | undefined = () => undefined
): Recorded => {
  const events = new Map<string, Handler>();
  const assistantContexts: RawAssistantThreadStarted[] = [];
  const assistantStarts: RawAssistantThreadStarted[] = [];
  const lines: Logged[] = [];
  const messages: Handler[] = [];
  const turns: RawSlackMessage[] = [];

  const app = {
    action: () => {},
    event: (name: string, handler: Handler) => {
      events.set(name, handler);
    },
    message: (handler: Handler) => {
      messages.push(handler);
    },
    view: () => {},
  } as unknown as App;

  registerListeners({
    app,
    changeAssistantContext: (event) => {
      assistantContexts.push(event);
    },
    dispatchInteraction: () => Promise.resolve(),
    dispatchView: () => Promise.resolve(),
    logger: {
      info: (message: string, ...rest: readonly unknown[]) => {
        lines.push({
          fields: (rest[0] ?? {}) as Record<string, unknown>,
          message,
        });
      },
    },
    openAssistantThread: (event) => {
      assistantStarts.push(event);
    },
    receiptAt,
    startTurn: (event) => {
      turns.push(event);
    },
  });

  return {
    assistantContexts,
    assistantStarts,
    events,
    lines,
    messages,
    turns,
  };
};

const deliver = async (
  recorded: Recorded,
  name: string,
  event: unknown,
  body?: unknown
): Promise<void> => {
  const handler = recorded.events.get(name);
  expect(handler).toBeDefined();
  await handler?.({
    body,
    event,
  });
};

const envelope = (eventId: string, event: unknown): unknown => ({
  event,
  event_id: eventId,
  team_id: "T1",
  type: "event_callback",
});

const dispatches = (recorded: Recorded): Logged[] =>
  recorded.lines.filter((line) => line.message === "[slack] turn dispatched");

describe("registerListeners", () => {
  test("subscribes to every event the manifest already sends", () => {
    expect([...harness().events.keys()].toSorted()).toEqual([
      "app_mention",
      "assistant_thread_context_changed",
      "assistant_thread_started",
    ]);
  });

  test("assistant_thread_started and _context_changed route separately", async () => {
    const recorded = harness();
    const pane = {
      assistant_thread: {
        channel_id: "D1",
        context: { channel_id: "C_BEHIND" },
        thread_ts: "1.1",
      },
    };

    await deliver(recorded, "assistant_thread_started", pane);
    await deliver(recorded, "assistant_thread_context_changed", pane);

    expect(recorded.assistantStarts).toHaveLength(1);
    expect(recorded.assistantContexts).toHaveLength(1);
  });

  test("a listener never awaits the turn it starts", async () => {
    const recorded = harness();
    const handler = recorded.events.get("app_mention");

    await expect(handler?.({ event: { text: "hi" } })).resolves.toBeUndefined();
    expect(recorded.turns).toHaveLength(1);
  });
});

describe("the turn-dispatch line", () => {
  test("joins the turn to its receipt by event id, and times the queue", async () => {
    const recorded = harness((eventId) =>
      eventId === "Ev-queue" ? performance.now() - 40 : undefined
    );

    await deliver(
      recorded,
      "app_mention",
      { text: "hi", type: "app_mention" },
      envelope("Ev-queue", { text: "hi", type: "app_mention" })
    );

    expect(dispatches(recorded)).toHaveLength(1);
    expect(dispatches(recorded)[0]?.fields).toMatchObject({
      addressed: true,
      event_id: "Ev-queue",
      event_type: "app_mention",
    });
    expect(
      dispatches(recorded)[0]?.fields.queue_ms as number
    ).toBeGreaterThanOrEqual(40);
  });

  test("a direct message is dispatched as addressed", async () => {
    const recorded = harness(() => performance.now());
    const message = { channel_type: "im", text: "hi", type: "message" };

    await recorded.messages[0]?.({
      body: envelope("Ev-im", message),
      message,
    });

    expect(recorded.turns).toHaveLength(1);
    expect(dispatches(recorded)[0]?.fields).toMatchObject({
      addressed: true,
      event_id: "Ev-im",
    });
  });

  test("a threaded channel reply is dispatched unaddressed", async () => {
    const recorded = harness(() => performance.now());
    const message = { text: "hi", thread_ts: "1.1", type: "message" };

    await recorded.messages[0]?.({
      body: envelope("Ev-thread", message),
      message,
    });

    expect(dispatches(recorded)[0]?.fields.addressed).toBe(false);
  });

  test("a channel message that starts no turn logs no dispatch", async () => {
    const recorded = harness(() => performance.now());
    const message = { text: "hi", type: "message" };

    await recorded.messages[0]?.({
      body: envelope("Ev-ignored", message),
      message,
    });

    expect(recorded.turns).toHaveLength(0);
    expect(dispatches(recorded)).toHaveLength(0);
  });

  test("an event whose receipt has already been pruned omits queue_ms", async () => {
    const recorded = harness(() => undefined);

    await deliver(
      recorded,
      "app_mention",
      { text: "hi", type: "app_mention" },
      envelope("Ev-pruned", { text: "hi", type: "app_mention" })
    );

    expect(dispatches(recorded)).toHaveLength(1);
    expect(dispatches(recorded)[0]?.fields.queue_ms).toBeUndefined();
    expect(dispatches(recorded)[0]?.fields.event_id).toBe("Ev-pruned");
  });

  test("a dispatch with no envelope at all still logs, without inventing an id", async () => {
    const recorded = harness();

    await deliver(recorded, "app_mention", { text: "hi" });

    expect(dispatches(recorded)).toHaveLength(1);
    expect(dispatches(recorded)[0]?.fields.event_id).toBeUndefined();
    expect(dispatches(recorded)[0]?.fields.queue_ms).toBeUndefined();
  });

  test("opening an assistant pane is not a turn and logs nothing", async () => {
    const recorded = harness(() => performance.now());
    const pane = { assistant_thread: { channel_id: "D1", thread_ts: "1.1" } };

    await deliver(
      recorded,
      "assistant_thread_started",
      pane,
      envelope("Ev-pane", pane)
    );

    expect(dispatches(recorded)).toHaveLength(0);
  });

  test("no user, channel, thread or message text is carried as a field", async () => {
    const recorded = harness(() => performance.now());
    const event = {
      channel: "C1",
      text: "a secret sentence",
      ts: "1.1",
      type: "app_mention",
      user: "U1",
    };

    await deliver(recorded, "app_mention", event, envelope("Ev-tags", event));

    const rendered = JSON.stringify(dispatches(recorded)[0]?.fields);
    expect(rendered).not.toContain("a secret sentence");
    expect(rendered).not.toContain("C1");
    expect(rendered).not.toContain("U1");
    expect(rendered).not.toContain("1.1");
  });
});
