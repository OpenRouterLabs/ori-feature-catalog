/**
 * interrupt-mode.test.ts — the rule the setting exists to change.
 *
 * Steering used to be unconditional: a second message in a busy thread always
 * interrupted the running turn, and queueing happened only when there was no
 * live turn to interrupt. That is right for one person correcting a run and
 * wrong for a room where several people talk at once, so it became a setting.
 *
 * `shouldSteer` is the whole of its effect on a turn.
 */

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { DEFAULT_INTERRUPT_MODE, InterruptMode, interruptModeFrom } from "../state/index.ts";
import { shouldSteer } from "./turn-routes.ts";

describe("what the setting changes", () => {
  test("a steerable turn steers while the surface is set to steer", () => {
    expect(shouldSteer(true, InterruptMode.Steer)).toBe(true);
  });

  test("the same turn queues once the operator says queue", () => {
    expect(shouldSteer(true, InterruptMode.Queue)).toBe(false);
  });

  test.each([
    [InterruptMode.Steer],
    [InterruptMode.Queue],
  ])("a dispatched turn never steers, under %s", (mode) => {
    // A dispatched or spawned turn is not somebody correcting a run — nobody
    // asked the running one to stop. That was true before the setting existed
    // and the setting must not make it steerable.
    expect(shouldSteer(false, mode)).toBe(false);
    expect(shouldSteer(undefined, mode)).toBe(false);
  });
});

describe("reading the stored value", () => {
  test("the default is steering, so upgrading changes no behaviour", () => {
    expect(DEFAULT_INTERRUPT_MODE).toBe(InterruptMode.Steer);
    expect(interruptModeFrom(undefined)).toBe(InterruptMode.Steer);
  });

  test.each([
    [InterruptMode.Queue],
    [InterruptMode.Steer],
  ])("%s round-trips", (mode) => {
    expect(interruptModeFrom(mode)).toBe(mode);
  });

  test.each([["", "nonsense", "STEER"]].flat())(
    "%s is not a mode and reads as the default",
    (raw) => {
      expect(interruptModeFrom(raw)).toBe(DEFAULT_INTERRUPT_MODE);
    }
  );

  test("a non-string reads as the default rather than throwing", () => {
    // The input is a stored row or a browser form field, so it is genuinely
    // unknown at the boundary.
    expect(interruptModeFrom(null)).toBe(DEFAULT_INTERRUPT_MODE);
    expect(interruptModeFrom(7)).toBe(DEFAULT_INTERRUPT_MODE);
  });
});
