import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { Effect } from "effect";

import type { MessageReplyShape } from "#src/message-reply/reply.ts";

import { decodeChoice } from "#src/helpers/blockers/blockers.ts";
import { BlockersMemory } from "#src/interactions/blocker.ts";
import { makeBlockerRoute, parseAskBody } from "./blocker-route.ts";

const recorder = (options: { failPost?: boolean } = {}) => {
  const posted: string[] = [];
  const updated: string[] = [];

  const reply = {
    attach: () => Effect.die("unused"),
    ref: {
      channelId: "C1",
      teamId: "T1",
      threadTs: "1700.1",
    },
    reply: () => Effect.die("unused"),
    replyBlocks: (blocks: readonly unknown[]) => {
      posted.push(JSON.stringify(blocks));
      return options.failPost === true
        ? Effect.fail(new Error("ratelimited") as never)
        : Effect.succeed({
            channel: "C1",
            ts: "1700.2",
          });
    },
    remove: () => Effect.void,
    update: () => Effect.void,
    updateBlocks: (_ts: string, blocks: readonly unknown[]) => {
      updated.push(JSON.stringify(blocks));
      return Effect.void;
    },
  } as unknown as MessageReplyShape;

  return {
    posted,
    reply,
    updated,
  };
};

const askIdFrom = (posted: readonly string[]): string => {
  const value = /"value":"([^"]+)"/u.exec(posted.at(-1) ?? "")?.at(1) ?? "";
  return decodeChoice(value)?.askId ?? "";
};

const ask = (body: unknown): Request =>
  new Request("http://127.0.0.1/slack/thread/ask", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

const askRegistered = (blockers: {
  readonly count: () => Effect.Effect<number>;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((yield* blockers.count()) > 0) {
        return;
      }
      yield* Effect.sleep(1);
    }
    throw new Error("the route never opened an ask");
  });

const question = {
  channel: "C1",
  choices: [
    {
      id: "rebase",
      label: "Rebase them",
    },
  ],
  question: "Rebase or close the 7 conflicting PRs?",
  thread_ts: "1700.1",
};

describe("parseAskBody", () => {
  test("refuses a body it cannot read rather than guessing", () => {
    expect(parseAskBody(null).ok).toBe(false);
    expect(parseAskBody({ channel: "C1" }).ok).toBe(false);
  });

  test("refuses an empty question — a blank blocker asks nothing", () => {
    expect(
      parseAskBody({
        ...question,
        question: "   ",
      }).ok
    ).toBe(false);
  });

  test("a blocker with no choices is refused, not posted unanswerable", () => {
    const parsed = parseAskBody({
      channel: "C1",
      question: "What now?",
      thread_ts: "1700.1",
    });

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain("at least one choice");
  });
});

describe("the ask route", () => {
  test.effect("holds the response until someone answers, then returns the answer", () =>
    Effect.gen(function* () {
      const rec = recorder();
      const blockers = yield* BlockersMemory;
      const route = makeBlockerRoute({
        blockers,
        replyFor: () => Promise.resolve(rec.reply),
        threadKeyFor: () => "slack:T1:C1:1700.1",
        workspaceTeamId: "T1",
      });

      const pending = route(ask(question));
      yield* askRegistered(blockers);

      const raced = yield* Effect.promise(() =>
        Promise.race([
          pending.then(() => "returned"),
          Promise.resolve("still waiting"),
        ])
      );

      expect(raced).toBe("still waiting");

      yield* blockers.answer(askIdFrom(rec.posted), "rebase");

      const response = yield* Effect.promise(() => pending);

      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        answer: "rebase",
        ok: true,
      });
    }));

  test.effect("retires the buttons once answered", () =>
    Effect.gen(function* () {
      const rec = recorder();
      const blockers = yield* BlockersMemory;
      const route = makeBlockerRoute({
        blockers,
        replyFor: () => Promise.resolve(rec.reply),
        threadKeyFor: () => "slack:T1:C1:1700.1",
        workspaceTeamId: "T1",
      });

      const pending = route(ask(question));
      yield* askRegistered(blockers);
      yield* blockers.answer(askIdFrom(rec.posted), "rebase");
      yield* Effect.promise(() => pending);

      expect(rec.updated.join("\n")).toContain("Rebase them");
      expect(rec.updated.join("\n")).not.toContain("actions");
    }));

  test.effect("gives up rather than pinning the turn on its whole deadline", () =>
    Effect.gen(function* () {
      const rec = recorder();
      const route = makeBlockerRoute({
        blockers: yield* BlockersMemory,
        replyFor: () => Promise.resolve(rec.reply),
        timeoutMs: 5,
        threadKeyFor: () => "slack:T1:C1:1700.1",
        workspaceTeamId: "T1",
      });

      const response = yield* Effect.promise(() => route(ask(question)));

      expect(response.status).toBe(408);
      expect(rec.updated.join("\n")).toContain("No answer");
    }));

  test.effect("a blocker Slack refused is a bad gateway, not a timeout", () =>
    Effect.gen(function* () {
      const rec = recorder({ failPost: true });
      const route = makeBlockerRoute({
        blockers: yield* BlockersMemory,
        replyFor: () => Promise.resolve(rec.reply),
        timeoutMs: 5,
        threadKeyFor: () => "slack:T1:C1:1700.1",
        workspaceTeamId: "T1",
      });

      const response = yield* Effect.promise(() => route(ask(question)));

      expect(response.status).toBe(502);
    }));

  test.effect("an oversized body is refused even when it declares no length", () =>
    Effect.gen(function* () {
      const rec = recorder();
      const route = makeBlockerRoute({
        blockers: yield* BlockersMemory,
        replyFor: () => Promise.resolve(rec.reply),
        threadKeyFor: () => "slack:T1:C1:1700.1",
        workspaceTeamId: "T1",
      });
      const huge = JSON.stringify({
        ...question,
        question: "x".repeat(64 * 1024),
      });

      const response = yield* Effect.promise(() =>
        route(
          new Request("http://127.0.0.1/slack/thread/ask", {
            body: new ReadableStream({
              start(controller): void {
                controller.enqueue(new TextEncoder().encode(huge));
                controller.close();
              },
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          })
        )
      );

      expect(response.status).toBe(413);
      expect(rec.posted).toHaveLength(0);
    }));

  test.effect("a malformed body is refused before anything is posted", () =>
    Effect.gen(function* () {
      const rec = recorder();
      const route = makeBlockerRoute({
        blockers: yield* BlockersMemory,
        replyFor: () => Promise.resolve(rec.reply),
        threadKeyFor: () => "slack:T1:C1:1700.1",
        workspaceTeamId: "T1",
      });

      const response = yield* Effect.promise(() => route(ask({ nope: true })));

      expect(response.status).toBe(400);
      expect(rec.posted).toHaveLength(0);
    }));
});
