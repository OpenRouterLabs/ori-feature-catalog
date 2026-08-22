/* oxlint-disable import/no-relative-parent-imports typescript/no-unsafe-type-assertion -- siblings are imported relatively, and the fake stands in for the Slack SDK shape */
import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import type { BlockersShape } from "./blocker.ts";
import type { InteractionPayload } from "./interactions.ts";

import { makeFakeSlackClient } from "../client/client-test-support.ts";
import {
  BLOCKER_ACTION_ID,
  encodeChoice,
} from "../helpers/blockers/blockers.ts";
import { registerBlockerHandlers } from "./blocker-handler.ts";
import { BlockersMemory } from "./blocker.ts";
import { makeInteractions } from "./interactions.ts";

const click = (value: string, triggerId?: string): InteractionPayload => ({
  actions: [
    {
      actionId: BLOCKER_ACTION_ID,
      value,
    },
  ],
  channelId: "C1",
  threadTs: "1700.1",
  triggerId,
  userId: "U1",
});

const wired = (): {
  readonly blockers: BlockersShape;
  readonly fake: ReturnType<typeof makeFakeSlackClient>;
  readonly interactions: ReturnType<typeof makeInteractions>;
} => {
  const fake = makeFakeSlackClient();
  const interactions = makeInteractions();
  const blockers = Effect.runSync(BlockersMemory);
  registerBlockerHandlers({
    blockers,
    interactions,
  });
  return {
    blockers,
    fake,
    interactions,
  };
};

describe("blocker clicks", () => {
  test("a listed choice answers the ask", async () => {
    const { blockers, interactions } = wired();
    const { answered, askId } = Effect.runSync(
      blockers.open("slack:T1:C1:1700.1")
    );

    await Effect.runPromise(
      interactions.dispatch(click(encodeChoice(askId, "rebase")))
    );

    expect(await answered).toEqual("rebase");
  });

  test("a value it cannot read is ignored, not guessed at", async () => {
    const { blockers, interactions } = wired();
    const { askId } = Effect.runSync(blockers.open("slack:T1:C1:1700.1"));

    await Effect.runPromise(interactions.dispatch(click("")));
    await Effect.runPromise(interactions.dispatch(click("no-separator")));

    // `expect(true).toBe(true)` used to stand here, which would have passed
    // just as happily if an unreadable click had answered the ask.
    expect(Effect.runSync(blockers.count())).toBe(1);
    expect(Effect.runSync(blockers.answer(askId, "rebase"))).toBe(true);
  });
});
