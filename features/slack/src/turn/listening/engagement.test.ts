/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { Effect } from "effect";

import type { ThreadRef } from "../../thread/index.ts";
import type { EngagementDeps, EngagementInput } from "./engagement.ts";
import type { GateContext, IncomingMessage } from "./gates.ts";
import type { ThreadListen } from "./listen.ts";

import { considerTurn } from "./engagement.ts";
import { UNSEEN_THREAD } from "./listen.ts";

const BOT = "U0SELF00";
const REF: ThreadRef = {
  channelId: "C1",
  teamId: "T1",
  threadTs: "1.0",
};
const KEY = "slack:T1:C1:1.0";

const gatesWith = (over: Partial<GateContext> = {}): GateContext => ({
  allowedUserIds: new Set(),
  botUserId: BOT,
  skipPrefixes: ["//"],
  ...over,
});

const messageWith = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  botId: undefined,
  subtype: undefined,
  text: "hello",
  userId: "U0ASKER0",
  ...over,
});

interface Harness {
  readonly deps: EngagementDeps;
  readonly stopped: string[];
  readonly notes: string[];
  readonly state: () => ThreadListen;
}

const harness = (over: Partial<GateContext> = {}): Harness => {
  const notes: string[] = [];
  const stopped: string[] = [];
  const store = new Map<string, ThreadListen>();
  return {
    deps: {
      gates: gatesWith(over),
      note: (_ref, text) =>
        Effect.sync(() => {
          notes.push(text);
        }),
      readListen: (key) => Effect.sync(() => store.get(key) ?? UNSEEN_THREAD),
      stop: (key) => {
        stopped.push(key);
      },
      updateListen: (key, change) =>
        Effect.sync(() => {
          const next = change(store.get(key) ?? UNSEEN_THREAD);
          store.set(key, next);
          return next;
        }),
    },
    notes,
    state: () => store.get(KEY) ?? UNSEEN_THREAD,
    stopped,
  };
};

const send = (
  h: Harness,
  message: Partial<IncomingMessage>,
  addressed = false
): Effect.Effect<"run" | "drop"> =>
  considerTurn(h.deps, {
    addressed,
    key: KEY,
    message: messageWith(message),
    ref: REF,
  } satisfies EngagementInput);

describe("an unengaged thread", () => {
  test.effect("ignores a message nobody addressed to the bot", () =>
    Effect.gen(function* () {
      const h = harness();
      expect(yield* send(h, {})).toBe("drop");
    }));

  test.effect("does not even record who spoke, so untouched threads cost nothing", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* send(h, {});
      expect(h.state()).toBe(UNSEEN_THREAD);
    }));
});

describe("an engaged thread", () => {
  test.effect("a mention engages it", () =>
    Effect.gen(function* () {
      const h = harness();
      expect(yield* send(h, {}, true)).toBe("run");
      expect(h.state().engaged).toBe(true);
    }));

  test.effect("answers a later reply that mentions nobody", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* send(h, {}, true);
      expect(yield* send(h, { text: "and the other one?" })).toBe("run");
    }));
});

describe("auto-mute", () => {
  test.effect("a second person makes the bot step back, silently", () =>
    Effect.gen(function* () {
      // The note was posted the moment a second person spoke — often an aside
      // mid-run, often not addressed to the bot at all — so a conversation
      // between colleagues collected surface chatter neither had asked for.
      // Two agents in one thread each posted their own.
      const h = harness();
      yield* send(h, {}, true);
      expect(yield* send(h, { userId: "U0OTHER0" })).toBe("drop");
      expect(h.state().muted).toBe(true);
      expect(h.notes).toHaveLength(0);

      yield* send(h, { userId: "U0THIRD0" });
      expect(h.notes).toHaveLength(0);
    }));

  test.effect("a bot entering the thread mutes it too", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* send(h, {}, true);
      yield* send(h, {
        botId: "B_OTHER",
        userId: "U0OTHRAP",
      });
      expect(h.state().muted).toBe(true);
    }));

  test.effect("a bot is counted but never answered", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* send(h, {}, true);
      const verdict = yield* send(h, {
        botId: "B_OTHER",
        userId: "U0OTHRAP",
      });
      expect(verdict).toBe("drop");
      expect(h.state().participants.has("U0OTHRAP")).toBe(true);
    }));

  test.effect("an app posting with only a bot_id still counts", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* send(h, {}, true);
      yield* send(h, {
        botId: "B_WEBHOOK",
        text: "build failed",
        userId: undefined,
      });
      expect(h.state().participants.has("B_WEBHOOK")).toBe(true);
      expect(h.state().muted).toBe(true);
    }));

  test.effect("the bot's own messages never count, so it cannot mute itself", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* send(h, {}, true);
      yield* send(h, {
        botId: "B_SELF",
        userId: BOT,
      });
      expect(h.state().muted).toBe(false);
      expect(h.state().participants.has(BOT)).toBe(false);
    }));

  test.effect("with our own id unknown, no bot counts rather than risking a self-mute", () =>
    Effect.gen(function* () {
      const h = harness({ botUserId: undefined });
      yield* send(h, {}, true);
      yield* send(h, {
        botId: "B_SELF",
        userId: "U0WHOEVR",
      });
      expect(h.state().muted).toBe(false);
    }));

  test.effect("a mention is still answered in a muted thread", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* send(h, {}, true);
      yield* send(h, { userId: "U0OTHER0" });
      expect(yield* send(h, { text: "<@U0SELF00> ping" }, true)).toBe("run");
    }));

  test.effect("a plain reply is not answered in a muted thread", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* send(h, {}, true);
      yield* send(h, { userId: "U0OTHER0" });
      expect(yield* send(h, {})).toBe("drop");
    }));
});

describe("what does not count as somebody joining", () => {
  test.effect("an aside", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* send(h, {}, true);
      const verdict = yield* send(h, {
        text: "// note to self",
        userId: "U0OTHER0",
      });
      expect(verdict).toBe("drop");
      expect(h.state().muted).toBe(false);
    }));

  test.effect("a join or an edit", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* send(h, {}, true);
      yield* send(h, {
        subtype: "channel_join",
        userId: "U0OTHER0",
      });
      yield* send(h, {
        subtype: "message_changed",
        userId: "U0THIRD0",
      });
      expect(h.state().muted).toBe(false);
    }));
});

describe("a message addressed to someone else", () => {
  test.effect("is not answered, even in a thread the bot is following", () =>
    Effect.gen(function* () {
      // "cc @lab to review too" is addressed to lab. Answering it anyway is the
      // bot deciding that anything said near it is said to it.
      const h = harness();
      yield* send(h, {}, true);

      expect(
        yield* send(h, { text: "cc <@U0LAB000> to review too if you'd like!" })
      ).toBe("drop");
    }));

  test.effect("hands the thread over rather than muting it", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* send(h, {}, true);
      yield* send(h, { text: "cc <@U0LAB000> to review too" });

      // Not muted — the crowd heuristic is left armed. Just no longer following.
      expect(h.state().engaged).toBe(false);
      expect(h.state().muted).toBe(false);
      expect(h.notes).toHaveLength(0);
    }));

  test.effect("a later plain reply is left alone too", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* send(h, {}, true);
      yield* send(h, { text: "cc <@U0LAB000> to review too" });

      expect(yield* send(h, { text: "yeah looks right" })).toBe("drop");
    }));

  test.effect("a mention brings the bot back", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* send(h, {}, true);
      yield* send(h, { text: "cc <@U0LAB000> to review too" });

      expect(
        yield* send(h, { text: "<@U0SELF00> what do you think?" }, true)
      ).toBe("run");
    }));

  test.effect("naming the bot alongside someone else still counts as ours", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* send(h, {}, true);

      expect(
        yield* send(h, { text: "<@U0LAB000> and <@U0SELF00> can you both look" })
      ).toBe("run");
    }));

  test.effect("with our own id unknown, nothing stands the thread down", () =>
    Effect.gen(function* () {
      // Every mention would read as someone else's, including ours, so the bot
      // would stand down on being addressed.
      const h = harness({ botUserId: undefined });
      yield* send(h, {}, true);

      expect(yield* send(h, { text: "cc <@U0LAB000> to review" })).toBe("run");
      expect(h.state().engaged).toBe(true);
    }));

  test.effect("a message naming nobody is unaffected", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* send(h, {}, true);

      expect(yield* send(h, { text: "and the other one?" })).toBe("run");
    }));
});

describe("stop", () => {
  test.effect("saying stop interrupts the run rather than starting one", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* send(h, {}, true);

      expect(yield* send(h, { text: "stop" })).toBe("drop");
      expect(h.stopped).toEqual([KEY]);
    }));

  test.effect("a few natural spellings all count", () =>
    Effect.gen(function* () {
      for (const word of ["cancel", "abort", "Stop!", "never mind"]) {
        const h = harness();
        yield* send(h, {}, true);
        yield* send(h, { text: word });

        expect(h.stopped).toEqual([KEY]);
      }
    }));

  test.effect("stop inside a sentence is a message, not a command", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* send(h, {}, true);

      expect(yield* send(h, { text: "stop using the cached client" })).toBe(
        "run"
      );
      expect(h.stopped).toEqual([]);
    }));
});

describe("unmute", () => {
  test.effect("brings the bot back and stops the heuristic re-firing", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* send(h, {}, true);
      yield* send(h, { userId: "U0OTHER0" });

      expect(yield* send(h, { text: "unmute" })).toBe("drop");
      expect(h.state().muted).toBe(false);
      // Muting says nothing; unmuting confirms, because that answers a request
      // somebody actually made.
      expect(h.notes).toHaveLength(1);

      expect(yield* send(h, { text: "carry on then" })).toBe("run");
      yield* send(h, { userId: "U0FORTH0" });
      expect(h.state().muted).toBe(false);
    }));
});
