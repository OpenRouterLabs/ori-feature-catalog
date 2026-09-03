import { describe, expect, test } from "#src/test-support/index.ts";

import { isStopRequest } from "./listen.ts";

describe("stopping a run by saying so", () => {
  test("a stop phrase stops it, not just the bare word", () => {
    expect(isStopRequest("cancel this run")).toBeTruthy();
    expect(isStopRequest("stop it")).toBeTruthy();
    expect(isStopRequest("stop the run")).toBeTruthy();
    expect(isStopRequest("abort")).toBeTruthy();
    expect(isStopRequest("never mind")).toBeTruthy();
  });

  test("a task that happens to start with a stop word is not a stop", () => {
    expect(isStopRequest("cancel the deploy PR")).toBeFalsy();
    expect(isStopRequest("stop perry from restarting")).toBeFalsy();
  });
});
