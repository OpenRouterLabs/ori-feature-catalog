import {
  afterEach,
  describe,
  expect,
  test,
} from "#src/test-support/effect-test.ts";

import { Context, Effect } from "effect";

import type { SlackRuntime } from "#src/index.ts";
import { type InteractionPayload, Interactions, makeInteractions } from "./interactions.ts";

import { featureState } from "#src/feature-state.ts";

import {
  onButton,
  registerCustomButtons,
  registeredButtonIds,
  resetCustomButtons,
} from "./custom.ts";

const click = (
  actionId: string,
  value?: string,
  rest?: Partial<InteractionPayload>
): InteractionPayload => ({
  actions: [{ actionId, value }],
  channelId: "C1",
  threadTs: "1700.1",
  triggerId: "trigger-that-must-not-leak",
  userId: "U1",
  ...rest,
});

afterEach(() => {
  resetCustomButtons();
  featureState().runtime = undefined;
});

describe("custom buttons", () => {
  test.effect("a click reaches the handler that registered the id", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      onButton("deploy_now", (c) => {
        seen.push(`${c.actionId}:${c.value ?? "-"}:${c.userId}`);
      });

      const interactions = makeInteractions();
      registerCustomButtons(interactions);
      yield* interactions.dispatch(click("deploy_now", "v1"));

      expect(seen).toEqual(["deploy_now:v1:U1"]);
    })
  );

  test.effect("registering after the surface is up still wires the button", () =>
    Effect.gen(function* () {
      const interactions = makeInteractions();
      expect(registerCustomButtons(interactions)).toEqual([]);

      featureState().runtime = {
        context: Context.make(Interactions, interactions),
      } as SlackRuntime;

      const seen: string[] = [];
      onButton("late", () => {
        seen.push("clicked");
      });
      yield* interactions.dispatch(click("late"));

      expect(seen).toEqual(["clicked"]);
    })
  );

  test.effect("the click carries no trigger id or response url", () =>
    Effect.gen(function* () {
      let keys: readonly string[] = [];
      onButton("inspect", (c) => {
        keys = Object.keys(c).sort();
      });
      const interactions = makeInteractions();
      registerCustomButtons(interactions);
      yield* interactions.dispatch(click("inspect"));

      expect(keys).toEqual([
        "actionId",
        "channelId",
        "threadTs",
        "userId",
        "value",
      ]);
    })
  );

  test.effect("the value comes off the matching action, not the first one", () =>
    Effect.gen(function* () {
      let got: string | undefined = "unset";
      onButton("second", (c) => {
        got = c.value;
      });
      const interactions = makeInteractions();
      registerCustomButtons(interactions);
      yield* interactions.dispatch({
        ...click("first", "wrong"),
        actions: [
          { actionId: "first", value: "wrong" },
          { actionId: "second", value: "right" },
        ],
      });

      expect(got).toBe("right");
    })
  );

  test("a reserved action id is refused at registration", () => {
    expect(() => onButton("ori_cancel_turn", () => {})).toThrow(/reserved/);
    expect(registeredButtonIds()).toEqual([]);
  });

  test("an empty action id is refused", () => {
    expect(() => onButton("   ", () => {})).toThrow(/non-empty/);
  });

  test.effect("last registration wins for the same id", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      onButton("dup", () => {
        seen.push("first");
      });
      onButton("dup", () => {
        seen.push("second");
      });
      const interactions = makeInteractions();
      registerCustomButtons(interactions);
      yield* interactions.dispatch(click("dup"));

      expect(seen).toEqual(["second"]);
    })
  );

  test.effect("an unregistered id is ignored rather than failing the dispatch", () =>
    Effect.gen(function* () {
      const interactions = makeInteractions();
      registerCustomButtons(interactions);

      expect(
        yield* interactions.dispatch(click("never_registered"))
      ).toBeUndefined();
    })
  );

  test.effect("a throwing handler dies rather than passing silently", () =>
    Effect.gen(function* () {
      onButton("boom", () => {
        throw new Error("handler exploded");
      });
      const interactions = makeInteractions();
      registerCustomButtons(interactions);

      expect(yield* interactions.dispatch(click("boom"))).toBeUndefined();
    })
  );

  test.effect("a rejecting async handler is awaited", () =>
    Effect.gen(function* () {
      let finished = false;
      onButton("slow", async () => {
        await Promise.resolve();
        finished = true;
      });
      const interactions = makeInteractions();
      registerCustomButtons(interactions);
      yield* interactions.dispatch(click("slow"));

      expect(finished).toBe(true);
    })
  );

  test("registerCustomButtons reports what it wired", () => {
    onButton("a", () => {});
    onButton("b", () => {});
    expect([...registerCustomButtons(makeInteractions())].sort()).toEqual([
      "a",
      "b",
    ]);
  });
});
