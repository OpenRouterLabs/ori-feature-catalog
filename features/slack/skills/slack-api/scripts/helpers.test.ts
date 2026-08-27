import { describe, expect, test } from "#src/test-support/effect-test.ts";
import { Result } from "effect";

import {
  getThreadContext,
  makeClient,
  markdownToSlack,
  requireFlags,
  resolveChannel,
  resolveThreadTs,
} from "./helpers.ts";

const IN_THREAD = {
  SLACK_CHANNEL_ID: "C-HERE",
  SLACK_THREAD_TS: "1700.1",
};

const failureMessage = (result: Result.Result<unknown, Error>): string =>
  Result.isFailure(result) ? result.failure.message : "";

describe("makeClient", () => {
  test("refuses to build a client with no token", async () => {
    // Every command goes through this, so it is the single place that stops a
    // token-less run before it opens a socket.
    const result = makeClient({});

    expect(Result.isFailure(result)).toBe(true);
    expect(failureMessage(result)).toContain("SLACK_BOT_TOKEN");
  });

  test("reads the token from the env map it was handed, not the process", () => {
    expect(Result.isSuccess(makeClient({ SLACK_BOT_TOKEN: "xoxb-test" }))).toBe(
      true
    );
  });
});

describe("getThreadContext", () => {
  test("reads the pane the turn is running in", () => {
    expect(getThreadContext(IN_THREAD)).toEqual({
      channel: "C-HERE",
      threadTs: "1700.1",
    });
  });

  test("treats a blank and the literal \"undefined\" as absent", () => {
    // A harness that expands a variable it does not have hands over one of
    // these two, and both would otherwise be sent to Slack as a channel id.
    expect(
      getThreadContext({
        SLACK_CHANNEL_ID: "undefined",
        SLACK_THREAD_TS: "",
      })
    ).toEqual({
      channel: undefined,
      threadTs: undefined,
    });
  });
});

describe("resolveChannel", () => {
  test("prefers the flag the caller passed", () => {
    expect(resolveChannel("C-FLAG", IN_THREAD)).toEqual(
      Result.succeed("C-FLAG")
    );
  });

  test("falls back to the channel the turn is in", () => {
    expect(resolveChannel(undefined, IN_THREAD)).toEqual(
      Result.succeed("C-HERE")
    );
  });

  test("with neither, says which flag to pass", () => {
    const result = resolveChannel(undefined, {});

    expect(Result.isFailure(result)).toBe(true);
    expect(failureMessage(result)).toContain("--channel");
    expect(failureMessage(result)).toContain("SLACK_CHANNEL_ID");
  });
});

describe("resolveThreadTs", () => {
  test("fills in the current thread for a same-channel call", () => {
    expect(
      resolveThreadTs("C-HERE", {
        env: IN_THREAD,
      })
    ).toEqual(Result.succeed("1700.1"));
  });

  test("accepts a thread ts that agrees with the env", () => {
    expect(
      resolveThreadTs("C-HERE", {
        env: IN_THREAD,
        threadTs: "1700.1",
      })
    ).toEqual(Result.succeed("1700.1"));
  });

  test("refuses a thread ts that contradicts the one in scope", () => {
    // Same channel, different thread: almost always a ts the model carried
    // over from earlier in its context, and posting there talks over strangers.
    const result = resolveThreadTs("C-HERE", {
      env: IN_THREAD,
      threadTs: "1600.9",
    });

    expect(Result.isFailure(result)).toBe(true);
    expect(failureMessage(result)).toContain("1600.9");
    expect(failureMessage(result)).toContain("1700.1");
  });

  test("refuses a cross-channel post with no thread named", () => {
    // Posting into a channel the turn is not in, at the top level, is how a
    // spawned run interrupts a room nobody asked it to.
    const result = resolveThreadTs("C-ELSEWHERE", {
      env: IN_THREAD,
    });

    expect(Result.isFailure(result)).toBe(true);
    expect(failureMessage(result)).toContain("C-ELSEWHERE");
    expect(failureMessage(result)).toContain("C-HERE");
  });

  test("allows a cross-channel post into a named thread", () => {
    expect(
      resolveThreadTs("C-ELSEWHERE", {
        env: IN_THREAD,
        threadTs: "1500.5",
      })
    ).toEqual(Result.succeed("1500.5"));
  });

  test("noThread wins over the cross-channel guard", () => {
    // Opening a top-level thread is spawn-thread's one legitimate write, and
    // it says so explicitly rather than being caught by the guard.
    expect(
      resolveThreadTs("C-ELSEWHERE", {
        env: IN_THREAD,
        noThread: true,
        threadTs: "1500.5",
      })
    ).toEqual(Result.succeed(undefined));
  });

  test("the guard can be switched off for a caller that means it", () => {
    expect(
      resolveThreadTs("C-ELSEWHERE", {
        env: IN_THREAD,
        guardCrossChannel: false,
      })
    ).toEqual(Result.succeed(undefined));
  });

  test("with no thread in scope the flags are honoured verbatim", () => {
    // Until the framework threads SLACK_* into the agent runtime, this is the
    // ordinary case: nothing to guard against, so nothing is guarded.
    expect(
      resolveThreadTs("C-ELSEWHERE", {
        env: {},
        threadTs: "1500.5",
      })
    ).toEqual(Result.succeed("1500.5"));
    expect(resolveThreadTs("C-ELSEWHERE", { env: {} })).toEqual(
      Result.succeed(undefined)
    );
  });

  test("an env channel of \"undefined\" leaves the guard inactive", () => {
    expect(
      resolveThreadTs("C-ELSEWHERE", {
        env: { SLACK_CHANNEL_ID: "undefined" },
      })
    ).toEqual(Result.succeed(undefined));
  });
});

describe("requireFlags", () => {
  test("passes when every required flag carries a value", () => {
    expect(
      requireFlags({ channel: "C1", ts: "1700.1" }, "conversations.replies", "ts")
    ).toEqual(Result.void);
  });

  test("names every missing flag and shows the call that would work", () => {
    const result = requireFlags({}, "conversations.replies", "channel", "ts");

    expect(Result.isFailure(result)).toBe(true);
    expect(failureMessage(result)).toContain("--channel, --ts");
    expect(failureMessage(result)).toContain(
      "Usage: slack.ts conversations.replies --channel <value> --ts <value>"
    );
  });

  test("treats an empty value as missing", () => {
    // `--ts=` parses to "", which Slack would reject with a far worse message.
    expect(
      Result.isFailure(requireFlags({ ts: "" }, "conversations.replies", "ts"))
    ).toBe(true);
  });
});

describe("markdownToSlack", () => {
  test("rewrites markdown emphasis into Slack's own mrkdwn", () => {
    // The converter also brackets emphasis with zero-width spaces, which is
    // why this looks for the run rather than comparing the whole string.
    expect(markdownToSlack("**bold**")).toContain("*bold*");
  });

  test("rewrites links into the angle-bracket form Slack renders", () => {
    expect(markdownToSlack("[the run](https://example.com)").trim()).toBe(
      "<https://example.com|the run>"
    );
  });
});
