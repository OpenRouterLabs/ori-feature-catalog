import { describe, expect, test } from "#src/test-support/index.ts";

import { DEFAULT_INTERRUPT_MODE, InterruptMode, interruptModeFrom } from "#src/state/settings.ts";
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
    expect(interruptModeFrom(null)).toBe(DEFAULT_INTERRUPT_MODE);
    expect(interruptModeFrom(7)).toBe(DEFAULT_INTERRUPT_MODE);
  });
});
