import { Duration, Effect, Option, Ref } from "effect";
import { TestClock } from "effect/testing";

import type { RunState } from "#src/message-stream/run-state.ts";

import { initialRunState } from "#src/message-stream/run-state.ts";
import { describe, expect, test } from "#src/test-support/index.ts";
import { armOnItNotice, onItText } from "#src/turn/on-it.ts";

const stateWith = (over: Partial<RunState>): RunState => ({
  ...initialRunState(),
  ...over,
});

const noticeFor = (input: {
  readonly text?: string;
  readonly tools?: readonly string[];
}): string | undefined =>
  Option.getOrUndefined(
    onItText(
      stateWith({
        text: input.text ?? "",
        tools: new Map((input.tools ?? []).map((name) => [name, 1])),
      })
    )
  );

describe("what the notice says", () => {
  test("the model's own first sentence is the signal", () => {
    expect(
      noticeFor({
        text: "I'll reproduce on the ori codebase first, then check the VM. Starting with the watcher.",
      })
    ).toBe(
      "On it: I'll reproduce on the ori codebase first, then check the VM."
    );
  });

  test("the tools it is running stand in when it has said nothing", () => {
    expect(noticeFor({ tools: ["Read", "Grep"] })).toBe(
      "On it — running Read, Grep."
    );
  });

  test("what it said beats what it is running", () => {
    expect(
      noticeFor({
        text: "Checking the reload watcher first.",
        tools: ["Read"],
      })
    ).toBe("On it: Checking the reload watcher first.");
  });

  test("a turn that has produced nothing has nothing to say yet", () => {
    expect(noticeFor({})).toBeUndefined();
  });

  test("a half-typed sentence is not signal, because it is posted once", () => {
    expect(noticeFor({ text: "I'll start by reproducing the" })).toBeUndefined();
  });

  test("a long opening sentence is cut on a word, not mid-word", () => {
    const sentence = "reproducing the failure on a clean checkout ".repeat(8);
    const notice = noticeFor({ text: `${sentence}.` }) ?? "";

    expect(notice).toStartWith("On it: ");
    expect(notice).toEndWith("…");

    const kept = notice.slice("On it: ".length, -1);
    expect(sentence).toStartWith(kept);
    expect(sentence.charAt(kept.length)).toBe(" ");
  });
});

describe("when the notice is posted", () => {
  const armed = (input: {
    readonly firstTurn?: boolean;
    readonly holdMs: number;
    readonly text?: string;
    readonly textAfterMs?: { readonly at: number; readonly text: string };
  }) =>
    Effect.gen(function* () {
      const posted: string[] = [];
      const state = yield* Ref.make(stateWith({ text: input.text ?? "" }));

      const notice = yield* armOnItNotice({
        delayMs: 1000,
        firstTurn: input.firstTurn ?? true,
        peek: Ref.get(state),
        post: (text) =>
          Effect.sync(() => {
            posted.push(text);
            return {
              channel: "C1",
              ts: "1.1",
            };
          }),
        recheckMs: 100,
      });

      const later = input.textAfterMs;
      if (later === undefined) {
        yield* TestClock.adjust(Duration.millis(input.holdMs));
      } else {
        yield* TestClock.adjust(Duration.millis(later.at));
        yield* Ref.set(state, stateWith({ text: later.text }));
        yield* TestClock.adjust(Duration.millis(input.holdMs - later.at));
      }

      yield* notice.stop;
      return posted;
    }).pipe(Effect.provide(TestClock.layer()));

  test.effect("a turn that settles before the delay says nothing", () =>
    Effect.gen(function* () {
      expect(
        yield* armed({
          holdMs: 500,
          text: "Checking the watcher.",
        })
      ).toBeEmpty();
    })
  );

  test.effect("a first turn still running past the delay explains itself", () =>
    Effect.gen(function* () {
      expect(
        yield* armed({
          holdMs: 5000,
          text: "Checking the watcher.",
        })
      ).toEqual(["On it: Checking the watcher."]);
    })
  );

  test.effect("it explains itself once, not on every recheck", () =>
    Effect.gen(function* () {
      expect(
        yield* armed({
          holdMs: 30_000,
          text: "Checking the watcher.",
        })
      ).toHaveLength(1);
    })
  );

  test.effect("a follow-up turn in an open thread stays quiet", () =>
    Effect.gen(function* () {
      expect(
        yield* armed({
          firstTurn: false,
          holdMs: 30_000,
          text: "Checking the watcher.",
        })
      ).toBeEmpty();
    })
  );

  test.effect("a turn with nothing to say yet waits rather than saying nothing", () =>
    Effect.gen(function* () {
      expect(
        yield* armed({
          holdMs: 5000,
          textAfterMs: {
            at: 2000,
            text: "Checking the watcher.",
          },
        })
      ).toEqual(["On it: Checking the watcher."]);
    })
  );
});
