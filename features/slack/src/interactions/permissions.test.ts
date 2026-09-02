/* oxlint-disable typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/max-lines-per-function eslint/require-await eslint/no-unsafe-optional-chaining typescript/no-invalid-void-type promise/avoid-new promise/param-names unicorn/consistent-function-scoping -- test doubles assert on recorded `unknown` args and stand in for Slack SDK shapes; cases read better whole than split */
import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { Effect, Schema } from "effect";

import type { InteractionPayload } from "./interactions.ts";

import { makeInteractions } from "./interactions.ts";
import {
  ELICITATION_ACTION_ID,
  PERMISSION_ACTION_ID,
  elicitationBlocks,
  permissionBlocks,
  permissionResolvedBlocks,
  registerPermissionHandlers,
} from "./permissions.ts";

const ButtonElementSchema = Schema.Struct({
  action_id: Schema.String,
  text: Schema.Struct({ text: Schema.String }),
  value: Schema.optionalKey(Schema.String),
});

type ButtonElement = typeof ButtonElementSchema.Type;

const buttonsOf = (blocks: readonly unknown[]): readonly ButtonElement[] => {
  const actions = blocks.find(
    (block): block is { elements: readonly ButtonElement[] } =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: string }).type === "actions"
  );
  return actions?.elements ?? [];
};

const request = {
  askedBy: "U1",
  correlationId: "corr-1",
  operation: "bash: rm -rf build",
  options: ["allow_once", "reject_once"] as const,
  sessionId: "sess-1",
};

const payload = (
  actionId: string,
  value: string | undefined,
  clickedBy = "U1"
): InteractionPayload => ({
  actions: [
    {
      actionId,
      value,
    },
  ],
  channelId: "C1",
  threadTs: "1.1",
  triggerId: "trig-1",
  userId: clickedBy,
});

describe("permissionBlocks", () => {
  test("renders one button per option, with human labels", () => {
    const buttons = buttonsOf(permissionBlocks(request));

    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.text.text)).toEqual(["Allow once", "Deny"]);
  });

  test("shows the operation the agent is asking about", () => {
    const rendered = JSON.stringify(permissionBlocks(request));

    expect(rendered).toContain("rm -rf build");
  });

  test("every button carries its own action id, under one prefix", () => {
    const buttons = buttonsOf(permissionBlocks(request));
    const ids = buttons.map((b) => b.action_id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith(PERMISSION_ACTION_ID))).toBe(true);
  });

  test("the value carries correlation, session and choice", () => {
    const [first] = buttonsOf(permissionBlocks(request));

    expect(first?.value).toContain("corr-1");
    expect(first?.value).toContain("sess-1");
    expect(first?.value).toContain("allow_once");
  });

  test("renders all four option kinds when offered", () => {
    const buttons = buttonsOf(
      permissionBlocks({
        ...request,
        options: [
          "allow_once",
          "allow_always",
          "reject_once",
          "reject_always",
        ] as const,
      })
    );

    expect(buttons.map((b) => b.text.text)).toEqual([
      "Allow once",
      "Always allow",
      "Deny",
      "Always deny",
    ]);
  });
});

describe("permissionResolvedBlocks", () => {
  test("keeps the operation and states the outcome", () => {
    const rendered = JSON.stringify(
      permissionResolvedBlocks({ operation: "bash: ls" }, "allow once")
    );

    expect(rendered).toContain("bash: ls");
    expect(rendered).toContain("allow once");
  });

  test("carries no buttons, so an answered request cannot be answered twice", () => {
    expect(
      buttonsOf(permissionResolvedBlocks({ operation: "x" }, "denied"))
    ).toHaveLength(0);
  });
});

describe("elicitationBlocks", () => {
  test("offers only the answers Slack can honestly collect", () => {
    const buttons = buttonsOf(
      elicitationBlocks({
        askedBy: "U1",
        correlationId: "c",
        message: "Which branch?",
        sessionId: "s",
      })
    );

    expect(buttons.map((b) => b.text.text)).toEqual(["Decline", "Cancel"]);
    const ids = buttons.map((b) => b.action_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith(ELICITATION_ACTION_ID))).toBe(true);
  });

  test("shows what was asked", () => {
    const rendered = JSON.stringify(
      elicitationBlocks({
        askedBy: "U1",
        correlationId: "c",
        message: "Which branch?",
        sessionId: "s",
      })
    );

    expect(rendered).toContain("Which branch?");
  });
});

describe("registerPermissionHandlers", () => {
  test.effect("a failing handler does not abandon the other actions", () =>
    Effect.gen(function* () {
      const interactions = makeInteractions();
      let secondRan = false;

      interactions.on("first", () =>
        Effect.sync(() => {
          throw new Error("bridge down");
        })
      );
      interactions.on("second", () =>
        Effect.sync(() => {
          secondRan = true;
        })
      );

      yield* interactions.dispatch({
        actions: [
          {
            actionId: "first",
            value: "x",
          },
          {
            actionId: "second",
            value: "y",
          },
        ],
        channelId: "C1",
        threadTs: "1.1",
        triggerId: "t",
        userId: "U1",
      });

      expect(secondRan).toBe(true);
    })
  );

  const dispatchWith = (
    actionId: string,
    value: string | undefined,
    clickedBy = "U1"
  ): Effect.Effect<readonly unknown[]> =>
    Effect.gen(function* () {
      const responses: unknown[] = [];
      const interactions = makeInteractions();
      registerPermissionHandlers(interactions, {
        respond: (response) => {
          responses.push(response);
          return Promise.resolve();
        },
      });

      yield* interactions.dispatch(payload(actionId, value, clickedBy));
      return responses;
    });

  test.effect("maps a chosen option to a selected permission response", () =>
    Effect.gen(function* () {
      const [response] = yield* dispatchWith(
        PERMISSION_ACTION_ID,
        buttonsOf(permissionBlocks(request))[0]?.value
      );

      expect(response).toEqual({
        correlationId: "corr-1",
        kind: "permission",
        response: {
          optionKind: "allow_once",
          outcome: "selected",
        },
        sessionId: "sess-1",
      });
    })
  );

  test.effect("an unrecognised choice cancels rather than inventing an option", () =>
    Effect.gen(function* () {
      const [response] = yield* dispatchWith(
        PERMISSION_ACTION_ID,
        "corr-1|sess-1|not_a_real_kind|U1"
      );

      expect(response).toMatchObject({
        response: { outcome: "cancelled" },
      });
    })
  );

  test.effect("maps decline and cancel to elicitation actions", () =>
    Effect.gen(function* () {
      const [declined] = yield* dispatchWith(
        ELICITATION_ACTION_ID,
        "corr-2|sess-2|decline|U1"
      );
      const [cancelled] = yield* dispatchWith(
        ELICITATION_ACTION_ID,
        "corr-2|sess-2|cancel|U1"
      );

      expect(declined).toMatchObject({
        kind: "elicitation",
        response: { action: "decline" },
      });
      expect(cancelled).toMatchObject({ response: { action: "cancel" } });
    })
  );

  test.effect.each([undefined, "", "only-one-field", "two|fields", "a|b|c"])(
    "a malformed value %p is ignored rather than answered wrongly",
    (value) =>
      Effect.gen(function* () {
        expect(yield* dispatchWith(PERMISSION_ACTION_ID, value)).toHaveLength(
          0
        );
      })
  );

  test.effect("a bystander cannot answer someone else's approval", () =>
    Effect.gen(function* () {
      const value = buttonsOf(permissionBlocks(request))[0]?.value;

      expect(
        yield* dispatchWith(PERMISSION_ACTION_ID, value, "U_BYSTANDER")
      ).toHaveLength(0);
    })
  );

  test.effect("a bystander cannot answer someone else's elicitation", () =>
    Effect.gen(function* () {
      expect(
        yield* dispatchWith(
          ELICITATION_ACTION_ID,
          "corr-2|sess-2|decline|U1",
          "U_BYSTANDER"
        )
      ).toHaveLength(0);
    })
  );

  test.effect("an unrelated action id is not handled", () =>
    Effect.gen(function* () {
      expect(
        yield* dispatchWith("something_else", "corr|sess|allow_once|U1")
      ).toHaveLength(0);
    })
  );
});
