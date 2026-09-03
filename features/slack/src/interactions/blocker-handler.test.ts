/* oxlint-disable typescript/no-unsafe-type-assertion -- the fake stands in for the Slack SDK shape */
import { describe, expect, test } from "#src/test-support/index.ts";

import { Effect } from "effect";

import type { BlockersShape } from "./blocker.ts";
import type { InteractionPayload } from "./interactions.ts";

import { makeFakeSlackClient } from "#src/client/client-test-support.ts";
import {
  BLOCKER_ACTION_ID,
  encodeChoice,
} from "#src/helpers/blockers/index.ts";
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

const wired = (): Effect.Effect<{
  readonly blockers: BlockersShape;
  readonly fake: ReturnType<typeof makeFakeSlackClient>;
  readonly interactions: ReturnType<typeof makeInteractions>;
}> =>
  Effect.gen(function* () {
    const fake = makeFakeSlackClient();
    const interactions = makeInteractions();
    const blockers = yield* BlockersMemory;
    registerBlockerHandlers({
      blockers,
      interactions,
    });
    return {
      blockers,
      fake,
      interactions,
    };
  });

describe("blocker clicks", () => {
  test.effect("a listed choice answers the ask", () =>
    Effect.gen(function* () {
      const { blockers, interactions } = yield* wired();
      const { answered, askId } = yield* blockers.open("slack:T1:C1:1700.1");

      yield* interactions.dispatch(click(encodeChoice(askId, "rebase")));

      expect(yield* Effect.promise(() => answered)).toEqual("rebase");
    })
  );

  test.effect("a value it cannot read is ignored, not guessed at", () =>
    Effect.gen(function* () {
      const { blockers, interactions } = yield* wired();
      const { askId } = yield* blockers.open("slack:T1:C1:1700.1");

      yield* interactions.dispatch(click(""));
      yield* interactions.dispatch(click("no-separator"));

      expect(yield* blockers.count()).toBe(1);
      expect(yield* blockers.answer(askId, "rebase")).toBe(true);
    })
  );
});
