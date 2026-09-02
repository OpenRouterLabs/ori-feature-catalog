import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { Effect } from "effect";

import { makeFakeSlackClient } from "#src/client/client-test-support.ts";
import { makeMessageReply } from "#src/message-reply/reply-live.ts";
import { initialRunState, RunPhase } from "./run-state.ts";
import { settle } from "./settle.ts";

const MINUTE = 60_000;
const STARTED = 1_000_000;

const smallPrintOf = Effect.fn("test.smallPrintOf")(function* (
  elapsedMs: number
) {
  const fake = makeFakeSlackClient();
  yield* makeMessageReply({
      channelId: "C1",
      teamId: "T1",
      threadTs: "1700.1",
    }).pipe(
      Effect.flatMap((reply) =>
        settle({
          now: STARTED + elapsedMs,
          reply,
          state: {
            ...initialRunState(STARTED),
            harness: "claude-code",
            model: "opus",
            phase: RunPhase.Done,
            text: "the answer",
          },
          superseded: false,
        })
      ),
    Effect.provide(fake.layer)
  );
  const args = fake.calls.at(-1)?.args as
    | {
        readonly blocks?: readonly {
          readonly type?: string;
          readonly elements?: readonly { readonly text?: string }[];
        }[];
      }
    | undefined;
  const contextBlock = args?.blocks?.find((b) => b.type === "context");
  return contextBlock?.elements?.[0]?.text ?? "";
});

describe("how long the turn took, in the answer's small print", () => {
  test.effect("reads as whole minutes", () =>
    Effect.gen(function* () {
      expect(yield* smallPrintOf(3 * MINUTE)).toContain("3m");
    })
  );

  test.effect("truncates rather than rounding, so 3m59s is still 3m", () =>
    Effect.gen(function* () {
      const printed = yield* smallPrintOf(3 * MINUTE + 59_000);
      expect(printed).toContain("3m");
      expect(printed).not.toContain("4m");
    })
  );

  test.effect("says <1m under a minute rather than 0m", () =>
    Effect.gen(function* () {
      const printed = yield* smallPrintOf(42_000);
      expect(printed).toContain("<1m");
      expect(printed).not.toContain("0m");
    })
  );

  test.effect("never prints a decimal", () =>
    Effect.gen(function* () {
      expect(yield* smallPrintOf(90_000)).not.toMatch(/\d\.\d/);
    })
  );

  test.effect("rides alongside the harness and model, not instead of them", () =>
    Effect.gen(function* () {
      const printed = yield* smallPrintOf(7 * MINUTE);
      expect(printed).toContain("claude-code");
      expect(printed).toContain("opus");
      expect(printed).toContain("7m");
    })
  );
});
