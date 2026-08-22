/* oxlint-disable typescript/no-unsafe-type-assertion unicorn/no-useless-undefined unicorn/no-array-sort -- the Bolt stand-in narrows App deliberately, and an explicit undefined is what a payload without that field carries */
import type { App } from "@slack/bolt";

import { describe, expect, test } from "bun:test";

import type {
  RawAssistantThreadStarted,
  RawSlackMessage,
} from "./listeners.ts";

import { registerListeners } from "./listeners.ts";

type Handler = (args: { readonly event: unknown }) => Promise<void>;

interface Recorded {
  readonly assistantContexts: RawAssistantThreadStarted[];
  readonly assistantStarts: RawAssistantThreadStarted[];
  readonly events: Map<string, Handler>;
  readonly turns: RawSlackMessage[];
}

/**
 * A Bolt stand-in that records which event names were subscribed to and hands
 * their handlers back, so a case can deliver one payload.
 */
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
    // The manifest subscribed to these long before anything handled them; an
    // unhandled subscription is an event Slack delivers into a void.
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

    // Started also offers the prompts; a context change must not re-offer them,
    // which is why they are two handlers and not one.
    expect(recorded.assistantStarts).toHaveLength(1);
    expect(recorded.assistantContexts).toHaveLength(1);
  });

  test("a listener never awaits the turn it starts", async () => {
    const recorded = harness();
    const handler = recorded.events.get("app_mention");

    // Bolt answers Slack only once every listener resolves, and Slack gives
    // that request three seconds — so this must settle without the turn.
    await expect(handler?.({ event: { text: "hi" } })).resolves.toBeUndefined();
    expect(recorded.turns).toHaveLength(1);
  });
});
