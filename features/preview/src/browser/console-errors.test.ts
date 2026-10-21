import { Effect } from "effect";

import { browserEnv, consoleErrors } from "#src/browser/index.ts";
import { describe, expect, it } from "#src/effect-bun-test.ts";

const sessionWith = (events: readonly unknown[]) => ({
  send: () => Effect.succeed(undefined),
  events: events as never[],
});

describe("consoleErrors", () => {
  it("reports console errors and thrown exceptions, and ignores other console output", () => {
    const errors = consoleErrors(
      sessionWith([
        { method: "Runtime.consoleAPICalled", params: { type: "error", args: [{ description: "TypeError: x is undefined" }, { value: 42 }] } },
        { method: "Runtime.consoleAPICalled", params: { type: "log", args: [{ value: "hello" }] } },
        { method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: y" } } } },
        { method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: "Uncaught (in promise)" } } },
        { method: "Page.loadEventFired", params: {} },
      ])
    );
    expect(errors).toEqual([
      "TypeError: x is undefined 42",
      "ReferenceError: y",
      "Uncaught (in promise)",
    ]);
  });
});

describe("browserEnv", () => {
  it("gives the browser the sandbox environment, never the intern's credentials", () => {
    const env = browserEnv({ ORI_DAEMON_TOKEN: "secret", PATH: "/usr/bin" }, "/preview/home");
    expect(env.HOME).toBe("/preview/home");
    expect(env.ORI_DAEMON_TOKEN).toBeUndefined();
  });
});
