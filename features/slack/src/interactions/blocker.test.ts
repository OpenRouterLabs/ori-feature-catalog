/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { Effect } from "effect";

import type { BlockersShape } from "./blocker.ts";

import {
  decodeChoice,
  encodeChoice,
  blockerBlocks,
} from "../helpers/blockers/blockers.ts";
import { BlockersMemory } from "./blocker.ts";

/** A fresh registry per test — held per built graph, not per module. */
const blockers = (): Effect.Effect<BlockersShape> => BlockersMemory;

describe("blocker asks", () => {
  test.effect("the turn waits until someone answers", () =>
    Effect.gen(function* () {
      const asks = yield* blockers();
      const { answered, askId } = yield* asks.open("slack:T1:C1:1700.1");

      expect(yield* asks.answer(askId, "rebase")).toBe(true);

      expect(yield* Effect.promise(() => answered)).toEqual("rebase");
    })
  );

  test.effect("a second answer is refused — the ask is already closed", () =>
    // Otherwise a double click answers a question twice, and the second one
    // resolves nothing while looking like it worked.
    Effect.gen(function* () {
      const asks = yield* blockers();
      const { askId } = yield* asks.open("slack:T1:C1:1700.1");
      yield* asks.answer(askId, "first");

      expect(yield* asks.answer(askId, "second")).toBe(false);
    })
  );

  test.effect("two graphs cannot see each other's asks", () =>
    // The whole reason this is a service rather than a module-level Map: a
    // stop/start reload, or two suites in one process, must not share state.
    Effect.gen(function* () {
      const first = yield* blockers();
      const second = yield* blockers();
      const { askId } = yield* first.open("slack:T1:C1:1700.1");

      expect(yield* second.count()).toBe(0);
      expect(yield* second.answer(askId, "x")).toBe(false);
    })
  );

  test.effect("an abandoned ask settles rather than hanging forever", () =>
    // The turn ended without an answer. If the promise stayed unsettled the
    // entry would hold the turn's closure for the daemon's lifetime.
    Effect.gen(function* () {
      const asks = yield* blockers();
      const { answered, askId } = yield* asks.open("slack:T1:C1:1700.1");

      expect(yield* asks.count()).toBe(1);

      yield* asks.abandon(askId, "the run ended before this was answered");
      const answer = yield* Effect.promise(() => answered);

      expect(answer).toContain("ended before");
      expect(yield* asks.count()).toBe(0);
    })
  );

  test.effect("answering an ask nobody is waiting on is reported, not thrown", () =>
    Effect.gen(function* () {
      const asks = yield* blockers();

      expect(yield* asks.answer("ask-gone", "x")).toBe(false);
    })
  );
});

describe("blocker block kit", () => {
  const ask = {
    askId: "ask-1",
    choices: [
      {
        id: "rebase",
        label: "Rebase it",
      },
      {
        id: "close",
        label: "Close it",
      },
    ],
    question: "PR #1220 conflicts and has 100 threads. What do you want?",
  };

  test("offers a button per choice", () => {
    // A fixed set of choices is a guess about what the reader wants to say,
    // and being wrong is what makes a prompt worse than no prompt.
    const rendered = JSON.stringify(blockerBlocks(ask));

    expect(rendered).toContain("Rebase it");
    expect(rendered).toContain("Close it");
    // No "Something else…": it opened a modal, and a reader with an answer
    // nobody listed can say so in the thread instead.
    expect(rendered).not.toContain("Something else");
  });

  test("round-trips the ask and choice through a button value", () => {
    // Same reason a correlation id travels in `value` elsewhere: the id is
    // only known at ask time, so it cannot live in a registered action id.
    const decoded = decodeChoice(encodeChoice("ask-7", "rebase"));

    expect(decoded).toEqual({
      askId: "ask-7",
      choiceId: "rebase",
    });
  });

  test("refuses a value it cannot read rather than guessing", () => {
    const missing: string | undefined = undefined;

    expect(decodeChoice(missing)).toBeUndefined();
    expect(decodeChoice("")).toBeUndefined();
  });
});

describe("a workspace that opens asks and never clicks them", () => {
  /** Mirrors `MAX_PENDING_ASKS` in blocker.ts — asserted, not imported. */
  const CAP = 200;

  test.effect("forgets the oldest rather than growing for the daemon's lifetime", () =>
    // An ask nobody clicks is never resolved and never removed by a click. The
    // route behind it times out and moves on, so the entry is the only thing
    // left, and it is the one thing nothing else deletes.
    Effect.gen(function* () {
      const asks = yield* blockers();
      const oldest = yield* asks.open("slack:T1:C1:1700.1");
      const second = yield* asks.open("slack:T1:C1:1700.1");
      for (let filled = 2; filled < CAP; filled += 1) {
        yield* asks.open("slack:T1:C1:1700.1");
      }

      expect(yield* asks.count()).toBe(CAP);

      yield* asks.open("slack:T1:C1:1700.1");

      expect(yield* asks.count()).toBe(CAP);
      expect(yield* asks.answer(oldest.askId, "too late")).toBe(false);
      expect(yield* asks.answer(second.askId, "still here")).toBe(true);
    })
  );

  test.effect("keeps every ask while it is under the cap", () =>
    // The eviction is a backstop, not a policy. A workspace with a hundred
    // open questions must still be able to answer the first of them.
    Effect.gen(function* () {
      const asks = yield* blockers();
      const oldest = yield* asks.open("slack:T1:C1:1700.1");
      for (let filled = 1; filled < CAP; filled += 1) {
        yield* asks.open("slack:T1:C1:1700.1");
      }

      expect(yield* asks.count()).toBe(CAP);
      expect(yield* asks.answer(oldest.askId, "rebase")).toBe(true);
    })
  );
});

describe("a turn that ends takes its blockers with it", () => {
  test.effect("every ask open in the thread settles, and none in another does", () =>
    // The ask lives in this service, not on the turn, so a cancelled or
    // steered run used to leave a live button pointing at a promise nobody
    // was awaiting — and whoever clicked it was told their answer had been
    // accepted by a run that ended fifteen minutes earlier.
    Effect.gen(function* () {
      const asks = yield* BlockersMemory;
      const mine = yield* asks.open("slack:T1:C1:1.1");
      const other = yield* asks.open("slack:T1:C1:2.2");

      yield* asks.abandonThread(
        "slack:T1:C1:1.1",
        "the run ended before this was answered"
      );

      expect(yield* Effect.promise(() => mine.answered)).toContain(
        "ended before"
      );
      expect(yield* asks.count()).toBe(1);
      expect(yield* asks.answer(other.askId, "still live")).toBe(true);
    })
  );
});
