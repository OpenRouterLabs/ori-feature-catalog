import type { AgentRuntimeEvent, Chat, ChatTurnInput } from "ori";

/* oxlint-disable typescript/no-unsafe-type-assertion import/no-relative-parent-imports -- the bridge fake stands in for the Chat surface, and modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
import { describe, expect, test } from "bun:test";

import { Effect, Layer } from "effect";

import type { StateStoreShape } from "../state/store.ts";

import { makeFakeSlackClient } from "../client/client-test-support.ts";
import { Blockers, BlockersMemory } from "../interactions/blocker.ts";
import {
  Interactions,
  makeInteractions,
} from "../interactions/interactions.ts";
import { MessageStream, MessageStreamLive } from "../message-stream/stream.ts";
import { StateStore, StateStoreMemory } from "../state/store.ts";
import { AssistantThreads, AssistantThreadsLive } from "../thread/assistant.ts";
import { ThreadContext, ThreadContextLive } from "../thread/thread.ts";
import { handleTurn } from "./handler/handler.ts";
import { SLACK_REPLY_STYLE, SLACK_STYLE_REMINDER } from "./reply-style.ts";

/** A store that already answers this thread, so the turn is not the first. */
const storeWithSession = async (): Promise<StateStoreShape> => {
  const store = await Effect.runPromise(StateStoreMemory);
  await Effect.runPromise(
    store.putSession("slack:T1:C1:1700.0001", {
      sessionId: "session-1",
      startedAt: 0,
    })
  );
  return store;
};

/** The prompt the surface puts in front of the agent. */
const promptOf = async (store?: StateStoreShape): Promise<string> => {
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

  await Effect.runPromise(
    handleTurn({
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
          // The turn path now prepares the assistant pane, so the service has
          // to be present even for a channel turn — every call is a no-op off
          // a pane, but the layer is still required to build the effect.
          Layer.effect(AssistantThreads)(AssistantThreadsLive())
        ).pipe(Layer.provideMerge(fake.layer))
      )
    )
  );

  return sent[0]?.prompt ?? "";
};

describe("the status obligations are not argued against later", () => {
  test("nothing in the prompt tells the agent the thread works in silence", async () => {
    // Twice now the block has stated the three obligations and then, a
    // paragraph later, told the agent that "the thread shows a twenty-minute
    // run working for all twenty minutes without you saying anything" — a
    // leftover from the version that discouraged posting. The model reads the
    // permission, says nothing, and the indicator falls back to the tool
    // count. The obligations only hold if nothing downstream takes them back.
    const prompt = await promptOf();

    for (const licence of [
      "without you saying anything",
      "You do not have to fill the silence",
      "If the run turns up nothing like that, say nothing",
      "a quiet minute reads as a run in progress",
    ]) {
      expect(prompt).not.toContain(licence);
    }
  });

  test("states the three obligations and that silence is the failure", async () => {
    const prompt = await promptOf();

    expect(prompt).toContain("POST WITHIN THE FIRST MINUTE");
    expect(prompt).toContain("KEEP IT CURRENT AS YOU WORK");
    expect(prompt).toContain("AND POST THE MOMENT YOU DISCOVER SOMETHING");
    expect(prompt).toContain("Silence is not restraint here");
  });
});

describe("technical answers should be drawn, not described", () => {
  test("asks for a picture whenever the answer has a shape", async () => {
    // Routing only tabular data meant an explanation — how a request flows,
    // why a run failed — stayed prose the reader has to rebuild a diagram
    // from in their head.
    const prompt = await promptOf();

    expect(prompt).toContain("DRAW IT rather than describe it");
    expect(prompt).toContain("why something failed");
  });

  test("says to reach for it unprompted", async () => {
    // It drew a good post-mortem diagram, but only when asked outright.
    const prompt = await promptOf();

    expect(prompt).toContain("without being asked");
  });
});

describe("scope discipline", () => {
  test("tells the agent to finish the ask, not the codebase", async () => {
    // A long run spent every status on splitting files to satisfy a line
    // limit — tidy, and not what anyone asked for. An hour of that is an
    // hour the person waiting got nothing.
    const prompt = await promptOf();

    expect(prompt).toContain("FINISH THE ASK, NOT THE CODEBASE");
  });

  test("says what to do when a lint rule is genuinely in the way", async () => {
    // Without this the rule reads as "never touch anything", which blocks the
    // change the person actually asked for.
    const prompt = await promptOf();

    expect(prompt).toContain("smallest");
    expect(prompt).toContain("leave it and say so");
  });
});

describe("the style is not restated on every turn", () => {
  test("the first turn of a session carries the whole thing", async () => {
    expect(await promptOf()).toContain(SLACK_REPLY_STYLE);
  });

  test("a later turn carries the reminder instead", async () => {
    const prompt = await promptOf(await storeWithSession());

    expect(prompt).toContain(SLACK_STYLE_REMINDER);
    expect(prompt).not.toContain("DRAW IT rather than describe it");
  });

  test("the reminder costs a fraction of the block it replaces", () => {
    expect(SLACK_STYLE_REMINDER.length * 4).toBeLessThan(
      SLACK_REPLY_STYLE.length
    );
  });
});

describe("what the reminder may not drop", () => {
  test("when an update is worth sending, with the command spelled out", async () => {
    const prompt = await promptOf(await storeWithSession());

    // The rule this pins: a reminder that only GESTURES at the script buys
    // back the twenty minutes of silence, so the command stays spelled out —
    // and it needs the sentence saying when to reach for it, or it is a bare
    // command line with nothing telling the model what it is for.
    expect(prompt).toContain("post inside the");
    // And the carve-out, or a greeting gets a status before its own answer.
    expect(prompt).toContain("a status before an immediate reply is noise");
    expect(prompt).toContain(
      "bun features/slack/skills/slack-status/scripts/index.ts"
    );
  });

  test("scope discipline, which is what decays on a long run", async () => {
    const prompt = await promptOf(await storeWithSession());

    expect(prompt).toContain("Finish the ask, not the codebase");
  });

  test("still says to draw a shape, and that tables render", async () => {
    // It used to say "Slack has no tables", which was true when it was
    // written and is why every comparison came back as a paragraph.
    const prompt = await promptOf(await storeWithSession());

    expect(prompt).toContain("slack-chart");
    expect(prompt).toContain("Tables and lists render natively");
  });
});
