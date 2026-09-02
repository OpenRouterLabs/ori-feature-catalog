import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { Effect } from "effect";

import { makeFakeSlackClient } from "#src/client/client-test-support.ts";
import {
  LIMITS,
  actions,
  button,
  capBlocks,
  section,
} from "./block-kit/blocks.ts";
import { openModal } from "./modals/modals.ts";
import { makeUserDirectory } from "./users/users.ts";

describe("section", () => {
  test("takes the same markdown every other block takes", () => {
    expect(section("**hi**").text.text.replaceAll("\u200b", "")).toBe("*hi*");
  });

  test("a link survives instead of arriving as its own source", () => {
    expect(section("see [PR #12](https://example.com/12)").text.text).toBe(
      "see <https://example.com/12|PR #12>"
    );
  });

  test("escapes a broadcast in text the model wrote", () => {
    expect(section("<!channel> ship it").text.text).not.toContain("<!channel>");
  });

  test("truncates past Slack's section ceiling rather than being rejected", () => {
    const rendered = section("x".repeat(LIMITS.sectionText + 500));

    expect(rendered.text.text.length).toBeLessThanOrEqual(LIMITS.sectionText);
    expect(rendered.text.text.endsWith("…")).toBe(true);
  });

  test("leaves text at exactly the limit alone", () => {
    const exact = "x".repeat(LIMITS.sectionText);

    expect(section(exact).text.text).toBe(exact);
  });
});

describe("button", () => {
  test("carries action id, label and value", () => {
    expect(
      button({
        actionId: "a",
        label: "Go",
        value: "v",
      })
    ).toEqual({
      action_id: "a",
      text: {
        text: "Go",
        type: "plain_text",
      },
      type: "button",
      value: "v",
    });
  });

  test("omits value entirely when not given", () => {
    expect(
      Object.keys(
        button({
          actionId: "a",
          label: "Go",
        })
      )
    ).not.toContain("value");
  });

  test("truncates an over-long label", () => {
    const rendered = button({
      actionId: "a",
      label: "y".repeat(LIMITS.buttonText + 20),
    });

    expect(rendered.text.text.length).toBeLessThanOrEqual(LIMITS.buttonText);
  });

  test("truncates an over-long value", () => {
    const rendered = button({
      actionId: "a",
      label: "Go",
      value: "z".repeat(LIMITS.buttonValue + 20),
    });

    expect((rendered.value ?? "").length).toBeLessThanOrEqual(
      LIMITS.buttonValue
    );
  });
});

describe("actions", () => {
  test("caps the element count Slack accepts", () => {
    const many = Array.from({ length: LIMITS.actionsElements + 5 }, (_, i) =>
      button({
        actionId: `a${i}`,
        label: `b${i}`,
      })
    );

    expect(actions(many).elements).toHaveLength(LIMITS.actionsElements);
  });
});

describe("capBlocks", () => {
  test("caps at Slack's per-message block ceiling", () => {
    const many = Array.from({ length: LIMITS.blocks + 10 }, () => ({}));

    expect(capBlocks(many)).toHaveLength(LIMITS.blocks);
  });

  test("leaves a short list untouched", () => {
    expect(capBlocks([1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe("openModal", () => {
  test.effect("sends a modal view with the given trigger", () =>
    Effect.gen(function* () {
      const fake = makeFakeSlackClient();

      yield* openModal(fake.shape, {
        triggerId: "trig-1",
        view: {
          blocks: [],
          title: "Details",
        },
      });

      const args = fake.calls[0]?.args as {
        trigger_id?: string;
        view?: { title?: { text?: string }; type?: string };
      };
      expect(fake.calls[0]?.op).toBe("views.open");
      expect(args.trigger_id).toBe("trig-1");
      expect(args.view?.type).toBe("modal");
      expect(args.view?.title?.text).toBe("Details");
    })
  );

  test.effect("defaults the close label", () =>
    Effect.gen(function* () {
      const fake = makeFakeSlackClient();

      yield* openModal(fake.shape, {
        triggerId: "t",
        view: {
          blocks: [],
          title: "T",
        },
      });

      const args = fake.calls[0]?.args as {
        view?: { close?: { text?: string } };
      };
      expect(args.view?.close?.text).toBe("Close");
    })
  );
});

describe("makeUserDirectory", () => {
  const build = (getUserName: () => Effect.Effect<string>) =>
    makeUserDirectory.pipe(
      Effect.provide(
        makeFakeSlackClient({ getUserName: getUserName as never }).layer
      )
    );

  test.effect("resolves a display name", () =>
    Effect.gen(function* () {
      const users = yield* build(() => Effect.succeed("ada"));

      expect(yield* users.resolve("U1")).toBe("ada");
    })
  );

  test.effect("caches so a repeated lookup does not re-hit Slack", () =>
    Effect.gen(function* () {
      let calls = 0;
      const users = yield* build(() => {
        calls += 1;
        return Effect.succeed("ada");
      });

      yield* users.resolve("U1");
      yield* users.resolve("U1");

      expect(calls).toBe(1);
    })
  );

  test.effect("falls back to the raw id when the lookup fails", () =>
    Effect.gen(function* () {
      const users = yield* build(
        () => Effect.fail(new Error("missing_scope")) as never
      );

      expect(yield* users.resolve("U_UNKNOWN")).toBe("U_UNKNOWN");
    })
  );
});
