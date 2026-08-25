/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
import { describe, expect, test } from "#src/test-support/effect-test.ts";

import type { ThreadRef } from "../thread/thread.ts";
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
      note: (_ref, text) => {
        notes.push(text);
        return Promise.resolve();
      },
      readListen: (key) => Promise.resolve(store.get(key) ?? UNSEEN_THREAD),
      stop: (key) => {
        stopped.push(key);
      },
      updateListen: (key, change) => {
        const next = change(store.get(key) ?? UNSEEN_THREAD);
        store.set(key, next);
        return Promise.resolve(next);
      },
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
): Promise<"run" | "drop"> =>
  considerTurn(h.deps, {
    addressed,
    key: KEY,
    message: messageWith(message),
    ref: REF,
  } satisfies EngagementInput);

describe("an unengaged thread", () => {
  test("ignores a message nobody addressed to the bot", async () => {
    const h = harness();
    expect(await send(h, {})).toBe("drop");
  });

  test("does not even record who spoke, so untouched threads cost nothing", async () => {
    const h = harness();
    await send(h, {});
    expect(h.state()).toBe(UNSEEN_THREAD);
  });
});

describe("an engaged thread", () => {
  test("a mention engages it", async () => {
    const h = harness();
    expect(await send(h, {}, true)).toBe("run");
    expect(h.state().engaged).toBe(true);
  });

  test("answers a later reply that mentions nobody", async () => {
    const h = harness();
    await send(h, {}, true);
    expect(await send(h, { text: "and the other one?" })).toBe("run");
  });
});

describe("auto-mute", () => {
  test("a second person makes the bot step back, silently", async () => {
    // The note was posted the moment a second person spoke — often an aside
    // mid-run, often not addressed to the bot at all — so a conversation
    // between colleagues collected surface chatter neither had asked for.
    // Two agents in one thread each posted their own.
    const h = harness();
    await send(h, {}, true);
    expect(await send(h, { userId: "U0OTHER0" })).toBe("drop");
    expect(h.state().muted).toBe(true);
    expect(h.notes).toHaveLength(0);

    await send(h, { userId: "U0THIRD0" });
    expect(h.notes).toHaveLength(0);
  });

  test("a bot entering the thread mutes it too", async () => {
    const h = harness();
    await send(h, {}, true);
    await send(h, {
      botId: "B_OTHER",
      userId: "U0OTHRAP",
    });
    expect(h.state().muted).toBe(true);
  });

  test("a bot is counted but never answered", async () => {
    const h = harness();
    await send(h, {}, true);
    const verdict = await send(h, {
      botId: "B_OTHER",
      userId: "U0OTHRAP",
    });
    expect(verdict).toBe("drop");
    expect(h.state().participants.has("U0OTHRAP")).toBe(true);
  });

  test("an app posting with only a bot_id still counts", async () => {
    const h = harness();
    await send(h, {}, true);
    await send(h, {
      botId: "B_WEBHOOK",
      text: "build failed",
      userId: undefined,
    });
    expect(h.state().participants.has("B_WEBHOOK")).toBe(true);
    expect(h.state().muted).toBe(true);
  });

  test("the bot's own messages never count, so it cannot mute itself", async () => {
    const h = harness();
    await send(h, {}, true);
    await send(h, {
      botId: "B_SELF",
      userId: BOT,
    });
    expect(h.state().muted).toBe(false);
    expect(h.state().participants.has(BOT)).toBe(false);
  });

  test("with our own id unknown, no bot counts rather than risking a self-mute", async () => {
    const h = harness({ botUserId: undefined });
    await send(h, {}, true);
    await send(h, {
      botId: "B_SELF",
      userId: "U0WHOEVR",
    });
    expect(h.state().muted).toBe(false);
  });

  test("a mention is still answered in a muted thread", async () => {
    const h = harness();
    await send(h, {}, true);
    await send(h, { userId: "U0OTHER0" });
    expect(await send(h, { text: "<@U0SELF00> ping" }, true)).toBe("run");
  });

  test("a plain reply is not answered in a muted thread", async () => {
    const h = harness();
    await send(h, {}, true);
    await send(h, { userId: "U0OTHER0" });
    expect(await send(h, {})).toBe("drop");
  });
});

describe("what does not count as somebody joining", () => {
  test("an aside", async () => {
    const h = harness();
    await send(h, {}, true);
    const verdict = await send(h, {
      text: "// note to self",
      userId: "U0OTHER0",
    });
    expect(verdict).toBe("drop");
    expect(h.state().muted).toBe(false);
  });

  test("a join or an edit", async () => {
    const h = harness();
    await send(h, {}, true);
    await send(h, {
      subtype: "channel_join",
      userId: "U0OTHER0",
    });
    await send(h, {
      subtype: "message_changed",
      userId: "U0THIRD0",
    });
    expect(h.state().muted).toBe(false);
  });
});

describe("a message addressed to someone else", () => {
  test("is not answered, even in a thread the bot is following", async () => {
    // "cc @lab to review too" is addressed to lab. Answering it anyway is the
    // bot deciding that anything said near it is said to it.
    const h = harness();
    await send(h, {}, true);

    expect(
      await send(h, { text: "cc <@U0LAB000> to review too if you'd like!" })
    ).toBe("drop");
  });

  test("hands the thread over rather than muting it", async () => {
    const h = harness();
    await send(h, {}, true);
    await send(h, { text: "cc <@U0LAB000> to review too" });

    // Not muted — the crowd heuristic is left armed. Just no longer following.
    expect(h.state().engaged).toBe(false);
    expect(h.state().muted).toBe(false);
    expect(h.notes).toHaveLength(0);
  });

  test("a later plain reply is left alone too", async () => {
    const h = harness();
    await send(h, {}, true);
    await send(h, { text: "cc <@U0LAB000> to review too" });

    expect(await send(h, { text: "yeah looks right" })).toBe("drop");
  });

  test("a mention brings the bot back", async () => {
    const h = harness();
    await send(h, {}, true);
    await send(h, { text: "cc <@U0LAB000> to review too" });

    expect(
      await send(h, { text: "<@U0SELF00> what do you think?" }, true)
    ).toBe("run");
  });

  test("naming the bot alongside someone else still counts as ours", async () => {
    const h = harness();
    await send(h, {}, true);

    expect(
      await send(h, { text: "<@U0LAB000> and <@U0SELF00> can you both look" })
    ).toBe("run");
  });

  test("with our own id unknown, nothing stands the thread down", async () => {
    // Every mention would read as someone else's, including ours, so the bot
    // would stand down on being addressed.
    const h = harness({ botUserId: undefined });
    await send(h, {}, true);

    expect(await send(h, { text: "cc <@U0LAB000> to review" })).toBe("run");
    expect(h.state().engaged).toBe(true);
  });

  test("a message naming nobody is unaffected", async () => {
    const h = harness();
    await send(h, {}, true);

    expect(await send(h, { text: "and the other one?" })).toBe("run");
  });
});

describe("stop", () => {
  test("saying stop interrupts the run rather than starting one", async () => {
    const h = harness();
    await send(h, {}, true);

    expect(await send(h, { text: "stop" })).toBe("drop");
    expect(h.stopped).toEqual([KEY]);
  });

  test("a few natural spellings all count", async () => {
    for (const word of ["cancel", "abort", "Stop!", "never mind"]) {
      const h = harness();
      await send(h, {}, true);
      await send(h, { text: word });

      expect(h.stopped).toEqual([KEY]);
    }
  });

  test("stop inside a sentence is a message, not a command", async () => {
    const h = harness();
    await send(h, {}, true);

    expect(await send(h, { text: "stop using the cached client" })).toBe("run");
    expect(h.stopped).toEqual([]);
  });
});

describe("unmute", () => {
  test("brings the bot back and stops the heuristic re-firing", async () => {
    const h = harness();
    await send(h, {}, true);
    await send(h, { userId: "U0OTHER0" });

    expect(await send(h, { text: "unmute" })).toBe("drop");
    expect(h.state().muted).toBe(false);
    // Muting says nothing; unmuting confirms, because that answers a request
    // somebody actually made.
    expect(h.notes).toHaveLength(1);

    expect(await send(h, { text: "carry on then" })).toBe("run");
    await send(h, { userId: "U0FORTH0" });
    expect(h.state().muted).toBe(false);
  });
});
