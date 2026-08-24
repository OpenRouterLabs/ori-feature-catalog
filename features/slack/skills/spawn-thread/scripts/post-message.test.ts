/**
 * post-message.ts and update-message.ts are the only writes in the feature
 * that do not go through the daemon, so the two things worth pinning are the
 * ones that happen before Slack is called at all: the credential check, and
 * that the cross-channel routing guard is actually wired into the poster
 * rather than only living in the helper it is tested from.
 *
 * The successful post needs a real workspace and is left to the daemon's own
 * integration path.
 */

import { describe, expect, test } from "bun:test";
import { Option, Result } from "effect";

import { decodePostMessageResponse, postMessage } from "./post-message.ts";
import { updateMessage } from "./update-message.ts";

const IN_THREAD = {
  SLACK_BOT_TOKEN: "xoxb-not-a-real-token",
  SLACK_CHANNEL_ID: "C-HERE",
  SLACK_THREAD_TS: "1700.1",
};

const failureMessage = (result: Result.Result<unknown, Error>): string =>
  Result.isFailure(result) ? result.failure.message : "";

describe("postMessage", () => {
  test("refuses without a token instead of calling Slack anonymously", async () => {
    const result = await postMessage({
      channel: "C-HERE",
      env: {},
      text: "hello",
    });

    expect(Result.isFailure(result)).toBe(true);
    expect(failureMessage(result)).toContain("SLACK_BOT_TOKEN");
  });

  test("refuses a top-level post into a channel the turn is not in", async () => {
    // The guard is the reason this write is safe to leave outside the daemon:
    // a spawn can open a thread where it was told to, and nowhere else.
    const result = await postMessage({
      channel: "C-ELSEWHERE",
      env: IN_THREAD,
      text: "hello",
    });

    expect(Result.isFailure(result)).toBe(true);
    expect(failureMessage(result)).toContain("Cross-channel post");
  });

  test("refuses a thread ts that contradicts the thread in scope", async () => {
    const result = await postMessage({
      channel: "C-HERE",
      env: IN_THREAD,
      text: "hello",
      threadTs: "1600.9",
    });

    expect(failureMessage(result)).toContain("does not match");
  });
});

describe("updateMessage", () => {
  test("refuses without a token instead of calling Slack anonymously", async () => {
    const result = await updateMessage({
      channel: "C-HERE",
      env: {},
      text: "updated",
      ts: "1700.1",
    });

    expect(Result.isFailure(result)).toBe(true);
    expect(failureMessage(result)).toContain("SLACK_BOT_TOKEN");
  });
});

describe("decodePostMessageResponse", () => {
  test("reads the ts off a normal chat.postMessage response", () => {
    const decoded = decodePostMessageResponse({
      ok: true,
      channel: "C1",
      ts: "1700.1",
    });
    expect(Option.getOrUndefined(decoded)?.ts).toBe("1700.1");
  });

  test("is None when Slack acknowledged without a ts", () => {
    expect(Option.isNone(decodePostMessageResponse({ ok: true }))).toBe(true);
  });

  // The pre-existing contract treats an empty ts as absent rather than as a
  // usable thread id, which is why the schema requires a NonEmptyString.
  test("is None for an empty ts rather than returning it", () => {
    expect(Option.isNone(decodePostMessageResponse({ ts: "" }))).toBe(true);
  });

  test("is None for a non-object response", () => {
    expect(Option.isNone(decodePostMessageResponse("nope"))).toBe(true);
  });
});
