import { describe, expect, test } from "#src/test-support/effect-test.ts";

import {
  cancelAll,
  enqueue,
  resetRegistry,
  TURN_SHUTDOWN_REASON,
  TURN_TIMEOUT_REASON,
} from "#src/thread/registry.ts";
import { initialRunState, RunPhase, renderRunState } from "./run-state.ts";

const rendered = (phase: RunPhase): string =>
  renderRunState({
    ...initialRunState(0),
    phase,
    text: "Half of the migration is applied.",
  });

describe("a restart is not a timeout", () => {
  test("the shutdown line names the restart", () => {
    expect(rendered(RunPhase.Shutdown)).toContain("Restarting");
  });

  test("it never claims the run is still going", () => {
    const line = rendered(RunPhase.Shutdown);

    expect(line).not.toContain("Still running");
    expect(line).not.toContain("I will post if it lands");
  });

  test("it says what to do instead, because nothing is coming", () => {
    expect(rendered(RunPhase.Shutdown)).toContain("Ask me again");
  });

  test("the work done before the restart is still shown", () => {
    expect(rendered(RunPhase.Shutdown)).toContain(
      "Half of the migration is applied."
    );
  });

  test("the timeout line is left alone, because it is true of a timeout", () => {
    const line = rendered(RunPhase.TimedOut);

    expect(line).toContain("Still running");
    expect(line).not.toContain("Restarting");
  });
});

describe("what shutdown aborts with", () => {
  test("a live turn is aborted with the shutdown reason, not the deadline's", async () => {
    resetRegistry();
    let reason: unknown;
    const running = enqueue(
      "T1:C1:1",
      () => Promise.resolve(),
      async (turn) => {
        await new Promise<void>((resolve) => {
          turn.signal.addEventListener("abort", () => {
            reason = turn.signal.reason;
            resolve();
          });
        });
      }
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(cancelAll()).toBe(1);
    await running;

    expect(reason).toBe(TURN_SHUTDOWN_REASON);
    expect(reason).not.toBe(TURN_TIMEOUT_REASON);
  });

  test("cancelAll tells nothing when no turn is live", () => {
    resetRegistry();

    expect(cancelAll()).toBe(0);
  });
});
