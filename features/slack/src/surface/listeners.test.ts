/* oxlint-disable typescript/no-unsafe-type-assertion unicorn/no-useless-undefined unicorn/no-array-sort -- the Bolt stand-in narrows App deliberately, and an explicit undefined is what a payload without that field carries */
import type { App } from "@slack/bolt";

import { Schema } from "effect";

import { describe, expect, test } from "#src/test-support/index.ts";
import { opaqueSchema } from "#src/schema-support.ts";

import type {
  RawAssistantThreadStarted,
  RawSlackMessage,
} from "./listeners.ts";

import { registerListeners } from "./listeners.ts";

type Handler = (args: { readonly event: unknown }) => Promise<void>;

const RecordedSchema = Schema.Struct({
  assistantContexts: opaqueSchema<RawAssistantThreadStarted[]>(
    "Recorded.assistantContexts"
  ),
  assistantStarts: opaqueSchema<RawAssistantThreadStarted[]>(
    "Recorded.assistantStarts"
  ),
  events: opaqueSchema<Map<string, Handler>>("Recorded.events"),
  turns: opaqueSchema<RawSlackMessage[]>("Recorded.turns"),
});

type Recorded = typeof RecordedSchema.Type;

const harness = (): Recorded => {
  const events = new Map<string, Handler>();
  const assistantContexts: RawAssistantThreadStarted[] = [];
  const assistantStarts: RawAssistantThreadStarted[] = [];
  const turns: RawSlackMessage[] = [];

  const app = {
    action: () => {},
    event: (name: string, handler: Handler) => {
      events.set(name, handler);
    },
    message: () => {},
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
    turns,
  };
};

const deliver = async (
  recorded: Recorded,
  name: string,
  event: unknown
): Promise<void> => {
  const handler = recorded.events.get(name);
  expect(handler).toBeDefined();
  await handler?.({ event });
};

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
