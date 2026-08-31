/* oxlint-disable import/no-relative-parent-imports typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/max-lines-per-function eslint/require-await eslint/no-unsafe-optional-chaining typescript/no-invalid-void-type promise/avoid-new promise/param-names unicorn/consistent-function-scoping -- test doubles assert on recorded `unknown` args and stand in for Slack SDK shapes */
import type { AgentRuntimeEvent, Chat, ChatTurnInput } from "ori";

import { Effect, Layer } from "effect";

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
import {
  AssistantThreads,
  AssistantThreadsLive,
} from "../../thread/assistant.ts";
import { ThreadContext, ThreadContextLive } from "../../thread/thread.ts";
import { handleTurn } from "./handler.ts";

export const ref = {
  channelId: "C1",
  teamId: "T1",
  threadTs: "1700.0001",
};

export const event = (type: string, payload: unknown): AgentRuntimeEvent =>
  ({
    payload,
    type,
  }) as unknown as AgentRuntimeEvent;

interface Harness {
  readonly sent: ChatTurnInput[];
  readonly bridge: Chat;
}

export const bridgeOf = (
  events: readonly AgentRuntimeEvent[],
  throwAfter?: boolean,
  beforeEach?: (index: number) => Promise<void>
): Harness => {
  const sent: ChatTurnInput[] = [];
  const bridge = {
    sendMessage: (input: ChatTurnInput): AsyncIterable<AgentRuntimeEvent> => {
      sent.push(input);
      return (async function* () {
        // oxlint-disable-next-line vitest/prefer-each -- this is a generator feeding the turn, not a table of cases
        for (let index = 0; index < events.length; index += 1) {
          await beforeEach?.(index);
          const item = events[index];
          if (item !== undefined) {
            yield item;
          }
        }
        if (throwAfter === true) {
          throw new Error("stream died");
        }
      })();
    },
  } as unknown as Chat;
  return {
    bridge,
    sent,
  };
};

export const liveTurn = () => {
  const controller = new AbortController();
  return {
    abort: () => {
      controller.abort();
    },
    readPartial: (): string => "",
    readAsk: (): string => "",
    signal: controller.signal,
    turnId: "turn-1",
  };
};

export const servicesFor = (fake: ReturnType<typeof makeFakeSlackClient>) =>
  Layer.mergeAll(
    Layer.effect(ThreadContext)(ThreadContextLive),
    Layer.effect(StateStore)(StateStoreMemory),
    Layer.effect(Blockers)(BlockersMemory),
    Layer.succeed(MessageStream)(MessageStreamLive),
    Layer.sync(Interactions)(makeInteractions),
    Layer.effect(AssistantThreads)(AssistantThreadsLive())
  ).pipe(Layer.provideMerge(fake.layer));

export const run = async (input: {
  readonly beforeEvent?: (index: number) => Promise<void>;
  readonly events: readonly AgentRuntimeEvent[];
  readonly failBlockPosts?: boolean;
  readonly live?: ReturnType<typeof liveTurn>;
  readonly replies?: readonly unknown[];
  readonly spawnDepth?: number;
  readonly text?: string;
  readonly throwAfter?: boolean;
}) => {
  const overrides =
    input.failBlockPosts === true
      ? {
          postMessage: (args: { blocks?: unknown }) =>
            args.blocks === undefined
              ? Effect.succeed({
                  channel: "C1",
                  ts: "1.1",
                })
              : Effect.fail(new Error("ratelimited")),
        }
      : {};
  const fake = makeFakeSlackClient(overrides as never, {
    "conversations.replies": () => ({ messages: input.replies ?? [] }),
  });
  const harness = bridgeOf(input.events, input.throwAfter, input.beforeEvent);
  const live = input.live ?? liveTurn();

  const services = servicesFor(fake);

  await Effect.runPromise(
    handleTurn({
      bridge: harness.bridge,
      live,
      turn: {
        ref,
        spawnDepth: input.spawnDepth,
        text: input.text ?? "do the thing",
        userId: "U1",
      },
    }).pipe(Effect.provide(services))
  );

  return {
    fake,
    live,
    sent: harness.sent,
  };
};

const ANSWER_OPS: ReadonlySet<string> = new Set(["chat.postMessage"]);

export const answered = (
  fake: ReturnType<typeof makeFakeSlackClient>
): string =>
  fake.calls
    .filter((call) => ANSWER_OPS.has(call.op))
    .map(
      (call) => (call.args as { markdown_text?: string }).markdown_text ?? ""
    )
    .join("\n");

const PROGRESS_OPS: ReadonlySet<string> = new Set([
  "chat.postMessage",
  "chat.update",
]);

export const progress = (
  fake: ReturnType<typeof makeFakeSlackClient>
): string =>
  JSON.stringify(fake.calls.filter((call) => PROGRESS_OPS.has(call.op)));

export const updated = (
  fake: ReturnType<typeof makeFakeSlackClient>
): string[] => [answered(fake), progress(fake)];
