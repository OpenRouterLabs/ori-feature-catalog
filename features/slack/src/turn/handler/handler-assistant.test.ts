/* oxlint-disable import/no-relative-parent-imports typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/no-use-before-define unicorn/no-useless-undefined promise/avoid-new unicorn/consistent-function-scoping -- siblings are imported relatively; test doubles stand in for Slack SDK and runtime shapes, and a manually released barrier is how a case reaches the live-turn window */
/**
 * handler-assistant.test.ts — what the assistant pane changes about a turn.
 *
 * Kept apart from `handler.test.ts` because these cases need a REMEMBERED pane
 * and that file's harness deliberately has none: the default is a channel, and
 * every pane-only call being a no-op there is itself the thing it pins.
 */

import type { AgentRuntimeEvent, Chat } from "ori";

import { describe, expect, test } from "bun:test";

import { Effect, Layer } from "effect";

import type { AssistantThreadsShape } from "../../thread/assistant.ts";

import { makeFakeSlackClient } from "../../client/client-test-support.ts";
import { Blockers, BlockersMemory } from "../../interactions/blocker.ts";
import {
  Interactions,
  makeInteractions,
} from "../../interactions/interactions.ts";
import {
  MessageStream,
  MessageStreamLive,
} from "../../message-stream/stream.ts";
import { StateStore, StateStoreMemory } from "../../state/store.ts";
import { AssistantThreads, keyOf } from "../../thread/assistant.ts";
import { ThreadContext, ThreadContextLive } from "../../thread/thread.ts";
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

/**
 * A bridge whose stream can be held open.
 *
 * `holdBefore` pauses the stream just before that event, which is how a case
 * reaches the window where a turn's status sink is registered — outside it
 * there is nothing to publish into.
 */
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

/** A recording assistant service, so a case sees what the turn asked of it. */
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

const runTurn = async (input: {
  readonly assistant: AssistantThreadsShape;
  readonly events?: readonly AgentRuntimeEvent[];
  readonly store?: Awaited<ReturnType<typeof makeStore>>;
  readonly text?: string;
}) => {
  const fake = makeFakeSlackClient(
    {},
    {
      "conversations.replies": () => ({ messages: [] }),
    }
  );
  const harness = bridgeOf(input.events ?? [event("turn.succeeded", {})]);
  const store = input.store ?? (await makeStore());

  const services = Layer.mergeAll(
    Layer.effect(ThreadContext)(ThreadContextLive),
    Layer.succeed(StateStore)(store),
    Layer.effect(Blockers)(BlockersMemory),
    Layer.succeed(MessageStream)(MessageStreamLive),
    Layer.sync(Interactions)(makeInteractions),
    Layer.succeed(AssistantThreads)(input.assistant)
  ).pipe(Layer.provideMerge(fake.layer));

  await Effect.runPromise(
    handleTurn({
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
    }).pipe(Effect.provide(services))
  );

  return {
    prompts: harness.prompts,
    store,
  };
};

/** A barrier a case can hold a stream on, then release. */
const makeStore = () => Effect.runPromise(StateStoreMemory);

describe("a turn in an assistant pane", () => {
  test("sets the native indicator before the agent has said anything", async () => {
    const assistant = recordingAssistant();

    await runTurn({ assistant: assistant.shape });

    // Something true while a run is live, so the pane is never blank; replaced
    // by the agent's own words as they land.
    expect(assistant.calls.at(0)).toBe("status:is thinking…");
  });

  test("clears the indicator when the run ends", async () => {
    const assistant = recordingAssistant();

    await runTurn({ assistant: assistant.shape });

    // Slack shows it until cleared, so a run that ends without this leaves the
    // pane thinking next to the answer it already posted.
    expect(assistant.calls.at(-1)).toBe("status:");
  });

  test("titles the thread from the first message only", async () => {
    const assistant = recordingAssistant();
    const store = await makeStore();

    const first = await runTurn({
      assistant: assistant.shape,
      events: [
        event("session.started", { sessionId: "sess-1" }),
        event("turn.succeeded", {}),
      ],
      store,
      text: "triage the open PRs please",
    });
    expect(first.prompts).toHaveLength(1);

    await runTurn({
      assistant: assistant.shape,
      store,
      text: "now do the second one",
    });

    // The title names the whole conversation in the reader's history, so
    // re-titling from every later message would keep renaming it.
    const titles = assistant.calls.filter((call) => call.startsWith("title:"));
    expect(titles).toEqual(["title:triage the open PRs please"]);
  });

  test("tells the agent which conversation the pane was opened from", async () => {
    const assistant = recordingAssistant({ channelId: "C_BEHIND" });

    const { prompts } = await runTurn({ assistant: assistant.shape });

    // Without this "summarise this channel" in a pane has no referent but the
    // question itself.
    expect(prompts.at(0)).toContain("<#C_BEHIND>");
    expect(prompts.at(0)).toContain("assistant pane");
  });

  test("says nothing about a pane when there is no context behind it", async () => {
    const assistant = recordingAssistant();

    const { prompts } = await runTurn({ assistant: assistant.shape });

    // A channel turn must not be told it is in a pane, and a pane opened from
    // nowhere has nothing to point at.
    expect(prompts.at(0)).not.toContain("assistant pane");
  });

  test("keys the pane by channel and thread, not by session id", () => {
    // A pane only exists in the installed workspace, and the callers have a
    // channel and a thread but not always a team.
    expect(keyOf(ref)).toBe(`${ref.channelId}:${ref.threadTs}`);
  });
});
