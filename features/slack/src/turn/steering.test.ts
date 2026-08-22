/* oxlint-disable promise/avoid-new eslint/prefer-destructuring import/no-relative-parent-imports -- a manually settled barrier is how a test holds a turn open, the recorded reason reads clearer as a member access, and the registry is a sibling of this feature rather than of this directory */
import { describe, expect, test } from "bun:test";

import {
  enqueue,
  resetRegistry,
  steerThread,
  TURN_STEER_REASON,
} from "../thread/registry.ts";

const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe("steering a live turn", () => {
  test("interrupts it and hands back the ask and the work", async () => {
    // Queueing meant a correction landed only after the run it was correcting
    // had finished — the one moment it was worth nothing.
    resetRegistry();
    let reason: unknown;
    const running = enqueue(
      "T1:C1:1",
      () => Promise.resolve(),
      async (turn) => {
        turn.readPartial = (): string => "found the conflict in the lockfile";
        turn.readAsk = (): string => "fix the failing build";
        turn.signal.addEventListener("abort", () => {
          reason = turn.signal.reason;
        });
        await new Promise<void>((resolve) => {
          turn.signal.addEventListener("abort", () => {
            resolve();
          });
        });
      }
    );
    await settle();

    const steered = steerThread("T1:C1:1");
    await running;

    expect(steered?.partial).toBe("found the conflict in the lockfile");
    // Without the ask, the correction that follows reads as the whole
    // assignment rather than as an amendment to this.
    expect(steered?.ask).toBe("fix the failing build");
    expect(reason).toBe(TURN_STEER_REASON);
  });

  test("reports nothing when the thread is idle", async () => {
    // Which is the caller's signal to start a turn normally instead.
    resetRegistry();

    expect(steerThread("T1:C1:nothing-here")).toBeUndefined();
    await settle();
  });

  test("a turn that never streamed steers with nothing to carry", async () => {
    // The partial reader is only replaced once the turn is running, so a steer
    // moments after arrival must still work rather than throw.
    resetRegistry();
    const running = enqueue(
      "T1:C1:2",
      () => Promise.resolve(),
      async (turn) => {
        await new Promise<void>((resolve) => {
          turn.signal.addEventListener("abort", () => {
            resolve();
          });
        });
      }
    );
    await settle();

    expect(steerThread("T1:C1:2")).toEqual({
      ask: "",
      partial: "",
    });
    await running;
  });
});
