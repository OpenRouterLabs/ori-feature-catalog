/* oxlint-disable import/no-relative-parent-imports typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/max-lines-per-function eslint/require-await eslint/no-unsafe-optional-chaining typescript/no-invalid-void-type promise/avoid-new promise/param-names unicorn/consistent-function-scoping -- test doubles assert on recorded `unknown` args and stand in for Slack SDK shapes */
/**
 * handler-test-support.ts — the turn harness shared by the handleTurn tests.
 *
 * `handler.test.ts` and `run-state.test.ts` drive the same turn path with the
 * same fake bridge, client and layer stack, so it is built once here. Extracted
 * when the case files split apart under the file-length budget.
 *
 * NOTE: `handler-rendering.test.ts` and `handler-assistant.test.ts` still carry
 * their own diverged copies of this harness (different `bridgeOf` options).
 * Unifying all four is a follow-up — it changes those cases, not these.
 */
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
import { StateStore, StateStoreMemory } from "../../state/index.ts";
import {
  AssistantThreads,
  AssistantThreadsLive,
} from "../../thread/index.ts";
import { ThreadContext, ThreadContextLive } from "../../thread/index.ts";
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

/**
 * The layer stack a turn needs, over a given fake client.
 *
 * Named rather than inlined into `run` because a test that drives `handleTurn`
 * directly — to run two turns against one store, say — needs the same stack;
 * two copies of it drift the moment a service is added.
 */
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
  /** Runs before the event at that index, to interleave an out-of-band write. */
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

/** What the thread ends up showing as the ANSWER. A turn posts it once. */
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

/** Everything the run put on screen, whichever transport carried it. */
const PROGRESS_OPS: ReadonlySet<string> = new Set([
  "chat.postMessage",
  "chat.update",
]);

export const progress = (
  fake: ReturnType<typeof makeFakeSlackClient>
): string =>
  JSON.stringify(fake.calls.filter((call) => PROGRESS_OPS.has(call.op)));

/** Kept for assertions that do not care which message the text landed on. */
export const updated = (
  fake: ReturnType<typeof makeFakeSlackClient>
): string[] => [answered(fake), progress(fake)];
