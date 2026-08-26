/* oxlint-disable import/no-relative-parent-imports typescript/no-unsafe-type-assertion -- modules inside this feature import siblings relatively, and the recorded args are `unknown` */
/**
 * responded-in.test.ts — the answer's small print says how long the turn took.
 *
 * Whole minutes only. The number is a receipt a reader glances at, not a
 * measurement, so a decimal would claim a precision it does not have.
 */
import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { makeFakeSlackClient } from "../client/client-test-support.ts";
import { makeMessageReply } from "../message-reply/reply-live.ts";
import { initialRunState, RunPhase } from "./run-state.ts";
import { settle } from "./settle.ts";

const MINUTE = 60_000;
const STARTED = 1_000_000;

/** The `context` block under the answer, which is where the small print lives. */
const smallPrintOf = async (elapsedMs: number): Promise<string> => {
  const fake = makeFakeSlackClient();
  await Effect.runPromise(
    makeMessageReply({
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
    )
  );
  // The context block's text, not the whole payload: `thread_ts` is a decimal
  // and would satisfy a naive "contains no decimal" assertion by accident.
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
};

describe("how long the turn took, in the answer's small print", () => {
  test("reads as whole minutes", async () => {
    expect(await smallPrintOf(3 * MINUTE)).toContain("3m");
  });

  test("truncates rather than rounding, so 3m59s is still 3m", async () => {
    const printed = await smallPrintOf(3 * MINUTE + 59_000);
    expect(printed).toContain("3m");
    expect(printed).not.toContain("4m");
  });

  // `0m` reads as a timer that never started; `<1m` reads as "fast".
  test("says <1m under a minute rather than 0m", async () => {
    const printed = await smallPrintOf(42_000);
    expect(printed).toContain("<1m");
    expect(printed).not.toContain("0m");
  });

  test("never prints a decimal", async () => {
    expect(await smallPrintOf(90_000)).not.toMatch(/\d\.\d/);
  });

  test("rides alongside the harness and model, not instead of them", async () => {
    const printed = await smallPrintOf(7 * MINUTE);
    expect(printed).toContain("claude-code");
    expect(printed).toContain("opus");
    expect(printed).toContain("7m");
  });
});
