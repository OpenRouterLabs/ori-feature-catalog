/* oxlint-disable typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/max-lines-per-function eslint/require-await eslint/no-unsafe-optional-chaining typescript/no-invalid-void-type promise/avoid-new promise/param-names unicorn/consistent-function-scoping -- test doubles assert on recorded `unknown` args and stand in for Slack SDK shapes; cases read better whole than split */
import { beforeEach, describe, expect, test } from "#src/test-support/effect-test.ts";

import type { LiveTurn } from "./registry.ts";

import { deferred } from "./registry-test-support.ts";
import {
  cancelAll,
  cancelTurn,
  drain,
  enqueue,
  isBusy,
  resetRegistry,
  threadCount,
  TURN_TIMEOUT_REASON,
} from "./registry.ts";

describe("registry growth", () => {
  test("forgets a thread once nothing is queued for it", async () => {
    // The cleanup path used to overwrite the entry rather than remove it, so
    // every thread the process had ever seen kept a row forever.
    resetRegistry();

    for (let i = 0; i < 200; i += 1) {
      await enqueue(
        `growth-${i}`,
        async () => {},
        async () => "done"
      );
    }

    expect(threadCount()).toBe(0);
  });

  test("keeps the entry while a turn is queued behind another", async () => {
    resetRegistry();
    const gate = deferred<void>();

    const first = enqueue(
      "held",
      async () => {},
      async () => {
        await gate.promise;
      }
    );

    await Promise.resolve();

    const second = enqueue(
      "held",
      async () => {},
      async () => "second"
    );

    expect(threadCount()).toBe(1);

    gate.resolve();
    await Promise.all([first, second]);

    expect(threadCount()).toBe(0);
  });
});

describe("cancellation reasons", () => {
  test("carries a caller-supplied reason through to the signal", async () => {
    // A deadline and a person clicking Cancel both abort the run. The reason
    // is what lets the surface tell someone which one happened, instead of
    // claiming a timeout was a cancellation and sending them to look for who
    // did it. The deadline itself is policy and lives at the composition root.
    let observed: unknown;

    await enqueue(
      "thread-reason",
      async () => {},
      async (turn) => {
        turn.abort(TURN_TIMEOUT_REASON);
        observed = turn.signal.reason;
      }
    );

    expect(observed).toBe(TURN_TIMEOUT_REASON);
  });

  test("a plain cancel carries no timeout reason", async () => {
    let observed: unknown;

    await enqueue(
      "thread-plain",
      async () => {},
      async (turn) => {
        turn.abort();
        observed = turn.signal.reason;
      }
    );

    expect(observed).not.toBe(TURN_TIMEOUT_REASON);
  });
});

describe("turn registry", () => {
  beforeEach(() => {
    resetRegistry();
  });

  test("serialises turns in the same thread, FIFO", async () => {
    const order: string[] = [];
    const first = deferred<void>();

    const a = enqueue(
      "T",
      async () => {},
      async () => {
        order.push("a:start");
        await first.promise;
        order.push("a:end");
      }
    );

    // Give `a` a tick to take the thread before `b` arrives.
    await Promise.resolve();

    const b = enqueue(
      "T",
      async () => {
        order.push("b:queued");
      },
      async () => {
        order.push("b:start");
      }
    );

    first.resolve();
    await Promise.all([a, b]);

    // The guarantees are that b was told it had to wait, and that it did not
    // start until a finished. Whether "b:queued" lands before or after
    // "a:start" is microtask scheduling, not a property worth pinning.
    expect(order).toContain("b:queued");
    expect(order.indexOf("a:end")).toBeLessThan(order.indexOf("b:start"));
  });

  test("different threads run concurrently", async () => {
    const gate = deferred<void>();
    let secondRan = false;

    const a = enqueue(
      "T1",
      async () => {},
      async () => {
        await gate.promise;
      }
    );
    const b = enqueue(
      "T2",
      async () => {},
      async () => {
        secondRan = true;
      }
    );

    await b;
    expect(secondRan).toBe(true);

    gate.resolve();
    await a;
  });

  test("a failed turn does not wedge the thread", async () => {
    const failing = enqueue(
      "T",
      async () => {},
      async () => {
        throw new Error("boom");
      }
    );
    await expect(failing).rejects.toThrow("boom");

    const after = await enqueue(
      "T",
      async () => {},
      async () => "ok"
    );
    expect(after).toBe("ok");
    expect(isBusy("T")).toBe(false);
  });

  test("cancelTurn aborts the running turn's signal", async () => {
    const started = deferred<string>();
    const finished = deferred<void>();

    const run = enqueue(
      "T",
      async () => {},
      async (live) => {
        started.resolve(live.turnId);
        await finished.promise;
        return live.signal.aborted;
      }
    );

    const turnId = await started.promise;
    expect(cancelTurn(turnId)).toBe(true);

    finished.resolve();
    expect(await run).toBe(true);
  });

  test("a throwing queued-notice does not wedge the thread forever", async () => {
    // The claim (pending + tail) is taken before onQueued runs. If that throw
    // escaped the try/finally, tail never resolved and every later turn in
    // this thread waited on a promise that would never settle.
    const gate = deferred<void>();
    const first = enqueue(
      "T",
      async () => {},
      async () => {
        await gate.promise;
      }
    );

    await Promise.resolve();

    const second = enqueue(
      "T",
      () => Promise.reject(new Error("slack down")),
      async () => "second ran"
    );

    gate.resolve();
    await first;

    expect(await second).toBe("second ran");
    expect(isBusy("T")).toBe(false);
  });

  test("drain resolves immediately when nothing is running", async () => {
    expect(await drain(50)).toBe(true);
  });

  test("drain waits for a live turn to finish", async () => {
    const gate = deferred<void>();
    let finished = false;
    const run = enqueue(
      "T",
      async () => {},
      async () => {
        await gate.promise;
        finished = true;
      }
    );

    await Promise.resolve();
    const draining = drain(5000);
    gate.resolve();

    expect(await draining).toBe(true);
    expect(finished).toBe(true);
    await run;
  });

  test("drain reports false rather than hanging on a wedged turn", async () => {
    // A stuck turn must not hold the process open forever.
    const never = deferred<void>();
    const run = enqueue(
      "T",
      async () => {},
      async () => {
        await never.promise;
      }
    );

    await Promise.resolve();
    expect(await drain(20)).toBe(false);

    never.resolve();
    await run;
  });

  test("resetRegistry frees threads a stopped run left claimed", async () => {
    // The maps are module-global, so a stop/start cycle would otherwise leave
    // the old run's threads busy and the next turn would queue forever.
    const never = deferred<void>();
    void enqueue(
      "T",
      async () => {},
      async () => {
        await never.promise;
      }
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(isBusy("T")).toBe(true);

    resetRegistry();

    expect(isBusy("T")).toBe(false);
    never.resolve();
  });

  test("cancelling a finished turn reports false rather than throwing", async () => {
    let seen = "";
    await enqueue(
      "T",
      async () => {},
      async (live) => {
        seen = live.turnId;
      }
    );

    expect(cancelTurn(seen)).toBe(false);
  });
});

describe("cancelAll", () => {
  test("tells every running turn to stop", async () => {
    // Shutdown waited for turns and then walked away from the ones still
    // going, stranding the message each one owned: no answer, no error, a
    // card still spinning. Aborting lets them settle on the way out.
    resetRegistry();
    const gate = deferred<void>();
    const started = deferred<void>();
    const reasons: unknown[] = [];

    const running = enqueue(
      "shutting-down",
      async () => {},
      async (live) => {
        live.signal.addEventListener("abort", () => {
          reasons.push(live.signal.reason);
          gate.resolve();
        });
        started.resolve();
        await gate.promise;
      }
    );
    await started.promise;

    expect(cancelAll()).toBe(1);
    await running;
    expect(reasons).toEqual([TURN_TIMEOUT_REASON]);
  });

  test("says nothing was running when nothing is", () => {
    resetRegistry();

    expect(cancelAll()).toBe(0);
  });
});

describe("turn ids", () => {
  test("carry a per-process nonce, not just a counter", async () => {
    // They were `turn-${n}` from a counter that restarts at 1 on every boot,
    // while anything keying durable state on them — the slack-status marker
    // file — outlived the process. So the first turns after a deploy read as
    // already-seen and silently lost the update that proves a run is alive.
    // A bare counter cannot be told apart across two boots at any width.
    resetRegistry();
    const ids: string[] = [];
    const record = async (turn: LiveTurn): Promise<void> => {
      ids.push(turn.turnId);
    };
    await enqueue("thread-a", async () => {}, record);
    await enqueue("thread-b", async () => {}, record);

    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(id).toMatch(/^turn-[0-9a-f]{8}-\d+$/u);
    }
    expect(ids[0]).not.toBe(ids[1]);
  });
});
