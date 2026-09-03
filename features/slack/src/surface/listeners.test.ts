/* oxlint-disable typescript/no-unsafe-type-assertion unicorn/no-useless-undefined unicorn/no-array-sort -- the Bolt stand-in narrows App deliberately, and an explicit undefined is what a payload without that field carries */
import type { App } from "@slack/bolt";

import { Schema } from "effect";

import { describe, expect, test } from "#src/test-support/index.ts";
import { opaqueSchema } from "#src/schema-support.ts";

import type {
  RawAssistantThreadStarted,
  RawSlackMessage,
} from "./listeners.ts";

import { readDispatch } from "#src/client/dispatch-note.ts";
import { registerListeners } from "./listeners.ts";

type Handler = (args: {
  readonly body?: unknown;
  readonly event?: unknown;
  readonly message?: unknown;
}) => Promise<void>;

const RecordedSchema = Schema.Struct({
  assistantContexts: opaqueSchema<RawAssistantThreadStarted[]>(
    "Recorded.assistantContexts"
  ),
  assistantStarts: opaqueSchema<RawAssistantThreadStarted[]>(
    "Recorded.assistantStarts"
  ),
  events: opaqueSchema<Map<string, Handler>>("Recorded.events"),
  messages: opaqueSchema<Handler[]>("Recorded.messages"),
  turns: opaqueSchema<RawSlackMessage[]>("Recorded.turns"),
});

type Recorded = typeof RecordedSchema.Type;

const harness = (): Recorded => {
  const events = new Map<string, Handler>();
  const assistantContexts: RawAssistantThreadStarted[] = [];
  const assistantStarts: RawAssistantThreadStarted[] = [];
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
    openAssistantThread: (event) => {
      assistantStarts.push(event);
    },
    startTurn: (event) => {
      turns.push(event);
    },
  });

  return {
    assistantContexts,
    assistantStarts,
    events,
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

const noted = (body: unknown): boolean | undefined =>
  typeof body === "object" && body !== null
    ? readDispatch(body)?.addressed
    : undefined;

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

describe("the dispatch note", () => {
  test("a mention is noted as addressed, on the body the receiver handed over", async () => {
    const recorded = harness();
    const body = envelope("Ev-mention", { text: "hi", type: "app_mention" });

    await deliver(
      recorded,
      "app_mention",
      { text: "hi", type: "app_mention" },
      body
    );

    expect(recorded.turns).toHaveLength(1);
    expect(noted(body)).toBe(true);
  });

  test("a direct message is noted as addressed", async () => {
    const recorded = harness();
    const message = { channel_type: "im", text: "hi", type: "message" };
    const body = envelope("Ev-im", message);

    await recorded.messages[0]?.({ body, message });

    expect(recorded.turns).toHaveLength(1);
    expect(noted(body)).toBe(true);
  });

  test("a threaded channel reply is noted as unaddressed", async () => {
    const recorded = harness();
    const message = { text: "hi", thread_ts: "1.1", type: "message" };
    const body = envelope("Ev-thread", message);

    await recorded.messages[0]?.({ body, message });

    expect(noted(body)).toBe(false);
  });

  test("a channel message that starts no turn notes nothing", async () => {
    const recorded = harness();
    const message = { text: "hi", type: "message" };
    const body = envelope("Ev-ignored", message);

    await recorded.messages[0]?.({ body, message });

    expect(recorded.turns).toHaveLength(0);
    expect(noted(body)).toBeUndefined();
  });

  test("opening an assistant pane is not a turn and notes nothing", async () => {
    const recorded = harness();
    const pane = { assistant_thread: { channel_id: "D1", thread_ts: "1.1" } };
    const body = envelope("Ev-pane", pane);

    await deliver(recorded, "assistant_thread_started", pane, body);

    expect(noted(body)).toBeUndefined();
  });

  test("a dispatch with no envelope at all is survived, not thrown on", async () => {
    const recorded = harness();

    await deliver(recorded, "app_mention", { text: "hi" });

    expect(recorded.turns).toHaveLength(1);
  });
});
