/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively */
import { describe, expect, test } from "bun:test";

import { isStopRequest } from "./listen.ts";

describe("stopping a run by saying so", () => {
  test("a stop phrase stops it, not just the bare word", () => {
    // The set was matched exactly, so "cancel" worked and "cancel this run"
    // did not — and with the button gone there was no other way to stop one.
    expect(isStopRequest("cancel this run")).toBeTruthy();
    expect(isStopRequest("stop it")).toBeTruthy();
    expect(isStopRequest("stop the run")).toBeTruthy();
    expect(isStopRequest("abort")).toBeTruthy();
    expect(isStopRequest("never mind")).toBeTruthy();
  });

  test("a task that happens to start with a stop word is not a stop", () => {
    // Reading "cancel the deploy PR" as a stop is worse than missing it.
    expect(isStopRequest("cancel the deploy PR")).toBeFalsy();
    expect(isStopRequest("stop perry from restarting")).toBeFalsy();
  });
});
