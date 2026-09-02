import type { AgentRuntimeEvent, Chat, ChatTurnInput } from "ori";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { Effect, Layer } from "effect";

import type { StateStoreShape } from "#src/state/store.ts";

import { makeFakeSlackClient } from "#src/client/client-test-support.ts";
import { Blockers, BlockersMemory } from "#src/interactions/blocker.ts";
import {
  Interactions,
  makeInteractions,
} from "#src/interactions/interactions.ts";
import { MessageStream, MessageStreamLive } from "#src/message-stream/stream.ts";
import { StateStore, StateStoreMemory } from "#src/state/store.ts";
import { AssistantThreads, AssistantThreadsLive } from "#src/thread/assistant.ts";
import { ThreadContext, ThreadContextLive } from "#src/thread/thread.ts";
import { handleTurn } from "./handler/handler.ts";
import { SLACK_REPLY_STYLE, SLACK_STYLE_REMINDER } from "./reply-style.ts";

const storeWithSession = (): Effect.Effect<StateStoreShape> =>
  Effect.gen(function* () {
    const store = yield* StateStoreMemory;
    yield* store.putSession("slack:T1:C1:1700.0001", {
      sessionId: "session-1",
      startedAt: 0,
    });
    return store;
  });

const promptOf = (store?: StateStoreShape): Effect.Effect<string> =>
  Effect.gen(function* () {
    const sent: ChatTurnInput[] = [];
    const bridge = {
      sendMessage: (input: ChatTurnInput): AsyncIterable<AgentRuntimeEvent> => {
        sent.push(input);
        return (async function* () {
          yield {
            payload: {},
            type: "turn.succeeded",
          } as AgentRuntimeEvent;
        })();
      },
    } as unknown as Chat;

    const fake = makeFakeSlackClient(
      {},
      { "conversations.replies": () => ({ messages: [] }) }
    );
    const controller = new AbortController();

    yield* handleTurn({
      bridge,
      live: {
        abort: (): void => {
          controller.abort();
        },
        readPartial: (): string => "",
        readAsk: (): string => "",
        signal: controller.signal,
        turnId: "turn-1",
      },
      turn: {
        ref: {
          channelId: "C1",
          teamId: "T1",
          threadTs: "1700.0001",
        },
        text: "do the thing",
        userId: "U1",
      },
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.effect(ThreadContext)(ThreadContextLive),
          store === undefined
            ? Layer.effect(StateStore)(StateStoreMemory)
            : Layer.succeed(StateStore)(store),
          Layer.succeed(MessageStream)(MessageStreamLive),
          Layer.effect(Blockers)(BlockersMemory),
          Layer.sync(Interactions)(makeInteractions),
          Layer.effect(AssistantThreads)(AssistantThreadsLive())
        ).pipe(Layer.provideMerge(fake.layer))
      )
    );

    return sent[0]?.prompt ?? "";
  });

describe("the status obligations are not argued against later", () => {
  test.effect("nothing in the prompt tells the agent the thread works in silence", () =>
    Effect.gen(function* () {
      const prompt = yield* promptOf();

      for (const licence of [
        "without you saying anything",
        "You do not have to fill the silence",
        "If the run turns up nothing like that, say nothing",
        "a quiet minute reads as a run in progress",
      ]) {
        expect(prompt).not.toContain(licence);
      }
    }));

  test.effect("states the three obligations and that silence is the failure", () =>
    Effect.gen(function* () {
      const prompt = yield* promptOf();

      expect(prompt).toContain("POST WITHIN THE FIRST MINUTE");
      expect(prompt).toContain("KEEP IT CURRENT AS YOU WORK");
      expect(prompt).toContain("AND POST THE MOMENT YOU DISCOVER SOMETHING");
      expect(prompt).toContain("Silence is not restraint here");
    }));
});

describe("technical answers should be drawn, not described", () => {
  test.effect("asks for a picture whenever the answer has a shape", () =>
    Effect.gen(function* () {
      const prompt = yield* promptOf();

      expect(prompt).toContain("DRAW IT rather than describe it");
      expect(prompt).toContain("why something failed");
    }));

  test.effect("says to reach for it unprompted", () =>
    Effect.gen(function* () {
      const prompt = yield* promptOf();

      expect(prompt).toContain("without being asked");
    }));
});

describe("scope discipline", () => {
  test.effect("tells the agent to finish the ask, not the codebase", () =>
    Effect.gen(function* () {
      const prompt = yield* promptOf();

      expect(prompt).toContain("FINISH THE ASK, NOT THE CODEBASE");
    }));

  test.effect("says what to do when a lint rule is genuinely in the way", () =>
    Effect.gen(function* () {
      const prompt = yield* promptOf();

      expect(prompt).toContain("smallest");
      expect(prompt).toContain("leave it and say so");
    }));
});

describe("the style is not restated on every turn", () => {
  test.effect("the first turn of a session carries the whole thing", () =>
    Effect.gen(function* () {
      expect(yield* promptOf()).toContain(SLACK_REPLY_STYLE);
    }));

  test.effect("a later turn carries the reminder instead", () =>
    Effect.gen(function* () {
      const prompt = yield* promptOf(yield* storeWithSession());

      expect(prompt).toContain(SLACK_STYLE_REMINDER);
      expect(prompt).not.toContain("DRAW IT rather than describe it");
    }));

  test("the reminder costs a fraction of the block it replaces", () => {
    expect(SLACK_STYLE_REMINDER.length * 4).toBeLessThan(
      SLACK_REPLY_STYLE.length
    );
  });
});

describe("what the reminder may not drop", () => {
  test.effect("when an update is worth sending, with the command spelled out", () =>
    Effect.gen(function* () {
      const prompt = yield* promptOf(yield* storeWithSession());

      expect(prompt).toContain("post inside the");
      expect(prompt).toContain("a status before an immediate reply is noise");
      expect(prompt).toContain(
        "bun features/slack/skills/slack-status/scripts/index.ts"
      );
    }));

  test.effect("scope discipline, which is what decays on a long run", () =>
    Effect.gen(function* () {
      const prompt = yield* promptOf(yield* storeWithSession());

      expect(prompt).toContain("Finish the ask, not the codebase");
    }));

  test.effect("still says to draw a shape, and that tables render", () =>
    Effect.gen(function* () {
      const prompt = yield* promptOf(yield* storeWithSession());

      expect(prompt).toContain("slack-chart");
      expect(prompt).toContain("Tables and lists render natively");
    }));
});
