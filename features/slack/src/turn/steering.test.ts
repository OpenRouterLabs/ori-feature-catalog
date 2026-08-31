/* oxlint-disable promise/avoid-new eslint/prefer-destructuring import/no-relative-parent-imports -- a manually settled barrier is how a test holds a turn open, the recorded reason reads clearer as a member access, and the registry is a sibling of this feature rather than of this directory */
import { describe, expect, test } from "#src/test-support/effect-test.ts";

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
    expect(steered?.ask).toBe("fix the failing build");
    expect(reason).toBe(TURN_STEER_REASON);
  });

  test("reports nothing when the thread is idle", async () => {
    resetRegistry();

    expect(steerThread("T1:C1:nothing-here")).toBeUndefined();
    await settle();
  });

  test("a turn that never streamed steers with nothing to carry", async () => {
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
