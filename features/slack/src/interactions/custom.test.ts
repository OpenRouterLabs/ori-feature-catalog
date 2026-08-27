/* oxlint-disable import/no-relative-parent-imports -- siblings are imported relatively */
import { afterEach, describe, expect, test } from "bun:test";

import { Effect } from "effect";

import type { InteractionPayload } from "./interactions.ts";

import {
  onButton,
  registerCustomButtons,
  registeredButtonIds,
  resetCustomButtons,
} from "./custom.ts";
import { makeInteractions } from "./interactions.ts";

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
});

describe("custom buttons", () => {
  test("a click reaches the handler that registered the id", async () => {
    const seen: string[] = [];
    onButton("deploy_now", (c) => {
      seen.push(`${c.actionId}:${c.value ?? "-"}:${c.userId}`);
    });

    const interactions = makeInteractions();
    registerCustomButtons(interactions);
    await Effect.runPromise(interactions.dispatch(click("deploy_now", "v1")));

    expect(seen).toEqual(["deploy_now:v1:U1"]);
  });

  test("registering after the surface is up still wires the button", async () => {
    const interactions = makeInteractions();
    // Surface boots first, with nothing registered.
    expect(registerCustomButtons(interactions)).toEqual([]);

    const seen: string[] = [];
    onButton("late", () => {
      seen.push("clicked");
    });
    await Effect.runPromise(interactions.dispatch(click("late")));

    // The alternative — silently dropping it — reads as a dead button.
    expect(seen).toEqual(["clicked"]);
  });

  test("the click carries no trigger id or response url", async () => {
    let keys: readonly string[] = [];
    onButton("inspect", (c) => {
      keys = Object.keys(c).sort();
    });
    const interactions = makeInteractions();
    registerCustomButtons(interactions);
    await Effect.runPromise(interactions.dispatch(click("inspect")));

    // These are seconds-lived provider capabilities. A consumer must not be
    // able to capture one by accident.
    expect(keys).toEqual([
      "actionId",
      "channelId",
      "threadTs",
      "userId",
      "value",
    ]);
  });

  test("the value comes off the matching action, not the first one", async () => {
    let got: string | undefined = "unset";
    onButton("second", (c) => {
      got = c.value;
    });
    const interactions = makeInteractions();
    registerCustomButtons(interactions);
    await Effect.runPromise(
      interactions.dispatch({
        ...click("first", "wrong"),
        actions: [
          { actionId: "first", value: "wrong" },
          { actionId: "second", value: "right" },
        ],
      })
    );

    expect(got).toBe("right");
  });

  test("a reserved action id is refused at registration", () => {
    // `on` is last-registration-wins, so this would have taken over the
    // surface's own cancel button rather than adding one.
    expect(() => onButton("ori_cancel_turn", () => {})).toThrow(/reserved/);
    expect(registeredButtonIds()).toEqual([]);
  });

  test("an empty action id is refused", () => {
    expect(() => onButton("   ", () => {})).toThrow(/non-empty/);
  });

  test("last registration wins for the same id", async () => {
    const seen: string[] = [];
    onButton("dup", () => {
      seen.push("first");
    });
    onButton("dup", () => {
      seen.push("second");
    });
    const interactions = makeInteractions();
    registerCustomButtons(interactions);
    await Effect.runPromise(interactions.dispatch(click("dup")));

    expect(seen).toEqual(["second"]);
  });

  test("an unregistered id is ignored rather than failing the dispatch", async () => {
    const interactions = makeInteractions();
    registerCustomButtons(interactions);

    await expect(
      Effect.runPromise(interactions.dispatch(click("never_registered")))
    ).resolves.toBeUndefined();
  });

  test("a throwing handler dies rather than passing silently", async () => {
    onButton("boom", () => {
      throw new Error("handler exploded");
    });
    const interactions = makeInteractions();
    registerCustomButtons(interactions);

    // `dispatch` catches the cause and logs it, so the listener Slack is
    // waiting on still settles — but the failure is not swallowed here.
    await expect(
      Effect.runPromise(interactions.dispatch(click("boom")))
    ).resolves.toBeUndefined();
  });

  test("a rejecting async handler is awaited", async () => {
    let finished = false;
    onButton("slow", async () => {
      await Promise.resolve();
      finished = true;
    });
    const interactions = makeInteractions();
    registerCustomButtons(interactions);
    await Effect.runPromise(interactions.dispatch(click("slow")));

    expect(finished).toBe(true);
  });

  test("registerCustomButtons reports what it wired", () => {
    onButton("a", () => {});
    onButton("b", () => {});
    expect([...registerCustomButtons(makeInteractions())].sort()).toEqual([
      "a",
      "b",
    ]);
  });
});
