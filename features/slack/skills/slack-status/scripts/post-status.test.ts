import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { postStatus, type PostStatusOutcome, type StatusEnv, type StatusPane } from "./post-status.ts";


const THREAD: StatusEnv = {
  SLACK_CHANNEL_ID: "C1",
  SLACK_THREAD_TS: "1.2",
};

const run = (input: {
  readonly env?: StatusEnv;
  readonly fails?: boolean;
  readonly lines?: string[];
  readonly notify?: boolean;
  readonly posted?: { pane: StatusPane; text: string }[];
  readonly text: string;
}): Promise<PostStatusOutcome> =>
  postStatus({
    env: input.env ?? THREAD,
    notify: input.notify ?? false,
    postMessage: (call) => {
      if (input.fails === true) {
        return Promise.reject(new Error("ratelimited"));
      }
      input.posted?.push(call);
      return Promise.resolve();
    },
    setLine: ({ text }) => {
      if (input.fails === true) {
        return Promise.reject(new Error("ratelimited"));
      }
      input.lines?.push(text);
      return Promise.resolve();
    },
    text: input.text,
  });

describe("the line is free; a message is not", () => {
  test("a bare update sets the indicator and posts nothing", async () => {
    const lines: string[] = [];
    const posted: { pane: StatusPane; text: string }[] = [];

    const outcome = await run({
      lines,
      posted,
      text: "reading run-events.ts",
    });

    expect(outcome).toMatchObject({
      kind: "posted",
      notified: false,
    });
    expect(lines).toEqual(["reading run-events.ts"]);
    expect(posted).toBeEmpty();
  });

  test("--notify posts the message AND sets the line", async () => {
    const lines: string[] = [];
    const posted: { pane: StatusPane; text: string }[] = [];

    const outcome = await run({
      lines,
      notify: true,
      posted,
      text: "It is not the code — the SDK is generated per machine",
    });

    expect(outcome).toMatchObject({
      kind: "posted",
      notified: true,
    });
    expect(posted.map((call) => call.text)).toEqual([
      "It is not the code — the SDK is generated per machine",
    ]);
    expect(lines).toHaveLength(1);
  });

  test("the message goes out before the line is set", async () => {
    const order: string[] = [];

    await postStatus({
      env: THREAD,
      notify: true,
      postMessage: () => {
        order.push("message");
        return Promise.resolve();
      },
      setLine: () => {
        order.push("line");
        return Promise.resolve();
      },
      text: "found it",
    });

    expect(order).toEqual(["message", "line"]);
  });

  test("the indicator has a tighter cap than a message", async () => {
    const long = "x".repeat(200);

    expect(await run({ text: long })).toMatchObject({ kind: "error" });
    expect(
      await run({
        notify: true,
        text: long,
      })
    ).toMatchObject({
      kind: "posted",
    });
  });
});

describe("what it refuses", () => {
  test("an empty update is a usage error, not a blank line", async () => {
    const lines: string[] = [];

    const outcome = await run({
      lines,
      text: "   ",
    });

    expect(outcome).toMatchObject({ kind: "error" });
    expect(lines).toBeEmpty();
  });

  test("a blank expansion reads as absent, not as a channel", async () => {
    const outcome = await run({
      env: {
        SLACK_CHANNEL_ID: "C1",
        SLACK_THREAD_TS: "",
      },
      text: "working",
    });

    expect(outcome).toMatchObject({ kind: "error" });
    expect(outcome.kind === "error" && outcome.message).toContain(
      "no Slack thread in scope"
    );
  });

  test("over the cap is rejected with the reason, never cut", async () => {
    const outcome = await run({
      notify: true,
      text: "x".repeat(301),
    });

    expect(outcome).toMatchObject({ kind: "error" });
    expect(outcome.kind === "error" && outcome.message).toContain("max 300");
  });

  test("a failed call is reported rather than thrown", async () => {
    const outcome = await run({
      fails: true,
      notify: true,
      text: "working",
    });

    expect(outcome).toMatchObject({ kind: "error" });
  });
});
