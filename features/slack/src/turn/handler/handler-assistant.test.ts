/* oxlint-disable typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/no-use-before-define unicorn/no-useless-undefined promise/avoid-new unicorn/consistent-function-scoping -- test doubles stand in for Slack SDK and runtime shapes, and a manually released barrier is how a case reaches the live-turn window */

import type { AgentRuntimeEvent, Chat } from "ori";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { Effect, Layer } from "effect";

import type { StateStoreShape } from "#src/state/store.ts";
import type { AssistantThreadsShape } from "#src/thread/assistant.ts";

import { makeFakeSlackClient } from "#src/client/client-test-support.ts";
import { Blockers, BlockersMemory } from "#src/interactions/blocker.ts";
import {
  Interactions,
  makeInteractions,
} from "#src/interactions/interactions.ts";
import {
  MessageStream,
  MessageStreamLive,
} from "#src/message-stream/stream.ts";
import { StateStore, StateStoreMemory } from "#src/state/store.ts";
import { AssistantThreads, keyOf } from "#src/thread/assistant.ts";
import { ThreadContext, ThreadContextLive } from "#src/thread/thread.ts";
import { handleTurn } from "./handler.ts";

const ref = {
  channelId: "D1",
  teamId: "T1",
  threadTs: "1700000000.000100",
};

const event = (type: string, payload: unknown): AgentRuntimeEvent =>
  ({
    payload,
    type,
  }) as unknown as AgentRuntimeEvent;

const bridgeOf = (
  events: readonly AgentRuntimeEvent[],
  holdBefore?: { readonly index: number; readonly until: Promise<void> }
) => {
  const prompts: string[] = [];
  const bridge = {
    sendMessage: (input: { readonly prompt: string }) => {
      prompts.push(input.prompt);
      return (async function* () {
        let index = 0;
        for (const one of events) {
          if (holdBefore !== undefined && index === holdBefore.index) {
            await holdBefore.until;
          }
          index += 1;
          yield one;
        }
      })();
    },
  } as unknown as Chat;
  return {
    bridge,
    prompts,
  };
};

const recordingAssistant = (paneContext?: {
  readonly channelId: string | undefined;
}): {
  readonly calls: string[];
  readonly shape: AssistantThreadsShape;
} => {
  const calls: string[] = [];
  return {
    calls,
    shape: {
      contextFor: () => Effect.succeed(paneContext as never),
      isPane: () => Effect.succeed(true),
      remember: () => Effect.void,
      setStatus: (_input, status) =>
        Effect.sync(() => {
          calls.push(`status:${status}`);
        }),
      setTitle: (_input, title) =>
        Effect.sync(() => {
          calls.push(`title:${title}`);
        }),
    },
  };
};

const runTurn = (input: {
  readonly assistant: AssistantThreadsShape;
  readonly events?: readonly AgentRuntimeEvent[];
  readonly store?: StateStoreShape;
  readonly text?: string;
}) =>
  Effect.gen(function* () {
    const fake = makeFakeSlackClient(
      {},
      {
        "conversations.replies": () => ({ messages: [] }),
      }
    );
    const harness = bridgeOf(input.events ?? [event("turn.succeeded", {})]);
    const store = input.store ?? (yield* StateStoreMemory);

    const services = Layer.mergeAll(
      Layer.effect(ThreadContext)(ThreadContextLive),
      Layer.succeed(StateStore)(store),
      Layer.effect(Blockers)(BlockersMemory),
      Layer.succeed(MessageStream)(MessageStreamLive),
      Layer.sync(Interactions)(makeInteractions),
      Layer.succeed(AssistantThreads)(input.assistant)
    ).pipe(Layer.provideMerge(fake.layer));

    yield* handleTurn({
      bridge: harness.bridge,
      live: {
        abort: () => {},
        readPartial: (): string => "",
        readAsk: (): string => "",
        signal: new AbortController().signal,
        turnId: "turn-1",
      },
      turn: {
        ref,
        text: input.text ?? "triage the open PRs please",
        userId: "U1",
      },
    }).pipe(Effect.provide(services));

    return {
      prompts: harness.prompts,
      store,
    };
  });

describe("a turn in an assistant pane", () => {
  test.effect("sets the native indicator before the agent has said anything", () =>
    Effect.gen(function* () {
      const assistant = recordingAssistant();

      yield* runTurn({ assistant: assistant.shape });

      expect(assistant.calls.at(0)).toBe("status:is thinking…");
    }));

  test.effect("clears the indicator when the run ends", () =>
    Effect.gen(function* () {
      const assistant = recordingAssistant();

      yield* runTurn({ assistant: assistant.shape });

      expect(assistant.calls.at(-1)).toBe("status:");
    }));

  test.effect("titles the thread from the first message only", () =>
    Effect.gen(function* () {
      const assistant = recordingAssistant();
      const store = yield* StateStoreMemory;

      const first = yield* runTurn({
        assistant: assistant.shape,
        events: [
          event("session.started", { sessionId: "sess-1" }),
          event("turn.succeeded", {}),
        ],
        store,
        text: "triage the open PRs please",
      });
      expect(first.prompts).toHaveLength(1);

      yield* runTurn({
        assistant: assistant.shape,
        store,
        text: "now do the second one",
      });

      const titles = assistant.calls.filter((call) => call.startsWith("title:"));
      expect(titles).toEqual(["title:triage the open PRs please"]);
    }));

  test.effect("tells the agent which conversation the pane was opened from", () =>
    Effect.gen(function* () {
      const assistant = recordingAssistant({ channelId: "C_BEHIND" });

      const { prompts } = yield* runTurn({ assistant: assistant.shape });

      expect(prompts.at(0)).toContain("<#C_BEHIND>");
      expect(prompts.at(0)).toContain("assistant pane");
    }));

  test.effect("says nothing about a pane when there is no context behind it", () =>
    Effect.gen(function* () {
      const assistant = recordingAssistant();

      const { prompts } = yield* runTurn({ assistant: assistant.shape });

      expect(prompts.at(0)).not.toContain("assistant pane");
    }));

  test("keys the pane by channel and thread, not by session id", () => {
    expect(keyOf(ref)).toBe(`${ref.channelId}:${ref.threadTs}`);
  });
});
