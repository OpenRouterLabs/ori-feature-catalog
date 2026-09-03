import { Duration, Effect, Option, Ref } from "effect";
import { TestClock } from "effect/testing";

import type { RunState } from "#src/message-stream/run-state.ts";

import { initialRunState } from "#src/message-stream/run-state.ts";
import { describe, expect, test } from "#src/test-support/index.ts";
import { armOnItNotice, isSmallTalk, onItText } from "#src/turn/on-it.ts";

const stateWith = (over: Partial<RunState>): RunState => ({
  ...initialRunState(),
  ...over,
});

const noticeFor = (input: {
  readonly ask: string;
  readonly text?: string;
  readonly tools?: readonly string[];
}): string | undefined =>
  Option.getOrUndefined(
    onItText({
      ask: input.ask,
      state: stateWith({
        text: input.text ?? "",
        tools: new Map((input.tools ?? []).map((name) => [name, 1])),
      }),
    })
  );

describe("what does not earn a notice", () => {
  test.each([
    "hey",
    "Hey!",
    "hi",
    "Hi there",
    "hello",
    "yo",
    "gm",
    "good morning",
    "sup",
    "howdy",
  ])("an opener carries no request: %s", (ask) => {
    expect(isSmallTalk(ask)).toBe(true);
  });

  test.each(["thanks", "Thanks!", "ty", "cool", "nice", "ok", "perfect"])(
    "an acknowledgement closes the turn: %s",
    (ask) => {
      expect(isSmallTalk(ask)).toBe(true);
    }
  );

  test.each(["hey ori", "Thanks, ori", "hi ori!"])(
    "naming the bot does not make it a request: %s",
    (ask) => {
      expect(isSmallTalk(ask)).toBe(true);
    }
  );

  test("a greeting stays silent even once the turn is doing work", () => {
    expect(
      noticeFor({
        ask: "hey",
        text: "Hello! How can I help?",
        tools: ["Read"],
      })
    ).toBeUndefined();
  });

  test("a real ask that happens to open with a greeting still earns one", () => {
    expect(isSmallTalk("hey can you fix the reload loop on tally")).toBe(false);
  });

  test("a question the length of a greeting is still a question", () => {
    expect(isSmallTalk("why?")).toBe(false);
  });
});

describe("a notice has to say something", () => {
  test("a turn that has produced nothing yet stays quiet", () => {
    expect(noticeFor({ ask: "fix the reload loop on tally" })).toBeUndefined();
  });

  test("a half-typed sentence is not signal, because it is posted once", () => {
    expect(
      noticeFor({
        ask: "fix the reload loop on tally",
        text: "I'll start by reproducing the",
      })
    ).toBeUndefined();
  });

  test("the model's own first sentence is the signal", () => {
    expect(
      noticeFor({
        ask: "fix the reload loop on tally",
        text: "I'll reproduce on the ori codebase first, then check the VM. Starting with the watcher.",
      })
    ).toBe(
      "On it: I'll reproduce on the ori codebase first, then check the VM."
    );
  });

  test("the tools it is running stand in when it has said nothing", () => {
    expect(
      noticeFor({
        ask: "fix the reload loop on tally",
        tools: ["Read", "Grep"],
      })
    ).toBe("On it — running Read, Grep.");
  });

  test("what it said beats what it is running", () => {
    expect(
      noticeFor({
        ask: "fix the reload loop on tally",
        text: "Checking the reload watcher first.",
        tools: ["Read"],
      })
    ).toBe("On it: Checking the reload watcher first.");
  });

  test("a long opening sentence is cut on a word, not mid-word", () => {
    const sentence = "reproducing the failure on a clean checkout ".repeat(8);
    const notice =
      noticeFor({
        ask: "fix it",
        text: `${sentence}.`,
      }) ?? "";

    expect(notice).toStartWith("On it: ");
    expect(notice).toEndWith("…");

    // Every word that survived is a whole word from the sentence, and the cut
    // landed where the sentence had a space.
    const kept = notice.slice("On it: ".length, -1);
    expect(sentence).toStartWith(kept);
    expect(sentence.charAt(kept.length)).toBe(" ");
  });
});

describe("when the notice is posted", () => {
  const armed = (input: {
    readonly ask: string;
    readonly holdMs: number;
    readonly text: string;
  }) =>
    Effect.gen(function* () {
      const posted: string[] = [];
      const state = yield* Ref.make(stateWith({ text: input.text }));

      const notice = yield* armOnItNotice({
        ask: input.ask,
        delayMs: 1000,
        peek: Ref.get(state),
        post: (text) =>
          Effect.sync(() => {
            posted.push(text);
            return {
              channel: "C1",
              ts: "1.1",
            };
          }),
      });

      yield* TestClock.adjust(Duration.millis(input.holdMs));
      yield* notice.stop;
      return posted;
    }).pipe(Effect.provide(TestClock.layer()));

  test.effect("a turn that settles before the delay says nothing", () =>
    Effect.gen(function* () {
      const posted = yield* armed({
        ask: "fix the reload loop",
        holdMs: 500,
        text: "Checking the watcher.",
      });

      expect(posted).toBeEmpty();
    })
  );

  test.effect("a turn still running past the delay explains itself once", () =>
    Effect.gen(function* () {
      const posted = yield* armed({
        ask: "fix the reload loop",
        holdMs: 5000,
        text: "Checking the watcher.",
      });

      expect(posted).toEqual(["On it: Checking the watcher."]);
    })
  );

  test.effect("a greeting that somehow runs long still says nothing", () =>
    Effect.gen(function* () {
      const posted = yield* armed({
        ask: "hey",
        holdMs: 5000,
        text: "Hello there.",
      });

      expect(posted).toBeEmpty();
    })
  );
});
