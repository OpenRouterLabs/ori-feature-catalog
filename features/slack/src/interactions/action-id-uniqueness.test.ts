import { Effect } from "effect";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import type { SlackBlock } from "#src/helpers/block-kit/blocks.ts";

import {
  BLOCKER_ACTION_ID,
  blockerBlocks,
} from "#src/helpers/blockers/blockers.ts";
import { makeInteractions } from "./interactions.ts";
import {
  ELICITATION_ACTION_ID,
  elicitationBlocks,
  PERMISSION_ACTION_ID,
  permissionBlocks,
} from "./permissions.ts";

const actionIdsOf = (blocks: readonly SlackBlock[]): readonly string[] =>
  blocks.flatMap((block) =>
    (
      (block as { readonly elements?: readonly { action_id?: string }[] })
        .elements ?? []
    ).flatMap((element) =>
      element.action_id === undefined ? [] : [element.action_id]
    )
  );

const expectUniqueUnder = (
  blocks: readonly SlackBlock[],
  prefix: string
): void => {
  const ids = actionIdsOf(blocks);

  expect(ids.length).toBeGreaterThan(1);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.every((id) => id.startsWith(prefix))).toBe(true);
};

describe("Slack refuses a message whose buttons share an action id", () => {
  test("a blocker offering three choices gives each its own id", () => {
    expectUniqueUnder(
      blockerBlocks({
        askId: "ask-1",
        choices: [
          { id: "rebase", label: "Rebase it" },
          { id: "close", label: "Close it" },
          { id: "hold", label: "Hold" },
        ],
        question: "What do you want?",
      }),
      BLOCKER_ACTION_ID
    );
  });

  test("a permission prompt gives each option its own id", () => {
    expectUniqueUnder(
      permissionBlocks({
        askedBy: "U1",
        correlationId: "corr-1",
        operation: "bash: rm -rf build",
        options: ["allow_once", "reject_once"],
        sessionId: "sess-1",
      }),
      PERMISSION_ACTION_ID
    );
  });

  test("an elicitation gives Decline and Cancel their own ids", () => {
    expectUniqueUnder(
      elicitationBlocks({
        askedBy: "U1",
        correlationId: "corr-1",
        message: "Which branch?",
        sessionId: "sess-1",
      }),
      ELICITATION_ACTION_ID
    );
  });
});

describe("dispatching a prefixed action", () => {
  test.effect("reaches the handler registered on the prefix", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const interactions = makeInteractions();
      interactions.onPrefix(BLOCKER_ACTION_ID, (payload) =>
        Effect.sync(() => {
          seen.push(payload.actions.at(0)?.value ?? "");
        })
      );

      yield* interactions.dispatch({
        actions: [
          {
            actionId: `${BLOCKER_ACTION_ID}|2`,
            value: "ask-1|hold",
          },
        ],
        channelId: "C1",
        threadTs: "1700.1",
        triggerId: undefined,
        userId: "U1",
      });

      expect(seen).toEqual(["ask-1|hold"]);
    })
  );

  test.effect("an exact registration wins over a prefix", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const interactions = makeInteractions();
      interactions.onPrefix(BLOCKER_ACTION_ID, () =>
        Effect.sync(() => {
          seen.push("prefix");
        })
      );
      interactions.on(`${BLOCKER_ACTION_ID}|0`, () =>
        Effect.sync(() => {
          seen.push("exact");
        })
      );

      yield* interactions.dispatch({
        actions: [
          {
            actionId: `${BLOCKER_ACTION_ID}|0`,
            value: "v",
          },
        ],
        channelId: "C1",
        threadTs: "1700.1",
        triggerId: undefined,
        userId: "U1",
      });

      expect(seen).toEqual(["exact"]);
    })
  );
});
