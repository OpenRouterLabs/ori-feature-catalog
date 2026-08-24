/**
 * `openDm` is a two-line passthrough, so what is worth pinning is the shape of
 * the call it makes and the fact that nothing gets called at all without a
 * token. The client is injected and typed to the one method reached
 * (`conversations.open`), cast once at the seam.
 */

import { describe, expect, test } from "bun:test";
import { Result } from "effect";

import type { WebClient } from "@slack/web-api";

import { openDm } from "./open-dm.ts";

interface OpenArgs {
  readonly users: string;
}

const OPEN_RESPONSE = {
  channel: {
    id: "D123",
  },
  ok: true,
};

const clientRecording = (calls: OpenArgs[]): WebClient =>
  ({
    conversations: {
      open: (args: OpenArgs) => {
        calls.push(args);
        return Promise.resolve(OPEN_RESPONSE);
      },
    },
  }) as unknown as WebClient;

const throwingClient = (error: Error): WebClient =>
  ({
    conversations: {
      open: () => Promise.reject(error),
    },
  }) as unknown as WebClient;

const failureMessage = (result: Result.Result<unknown, Error>): string =>
  Result.isFailure(result) ? result.failure.message : "";

describe("openDm", () => {
  test("refuses without a token instead of calling Slack anonymously", async () => {
    const result = await openDm({
      env: {},
      users: "U1",
    });

    expect(Result.isFailure(result)).toBe(true);
    expect(failureMessage(result)).toContain("SLACK_BOT_TOKEN");
  });

  test("asks Slack to open a DM with the users it was given", async () => {
    const calls: OpenArgs[] = [];
    await openDm({
      client: clientRecording(calls),
      users: "U1",
    });

    expect(calls).toEqual([{ users: "U1" }]);
  });

  test("passes a multi-user list through verbatim", async () => {
    // Slack's own contract is a comma-joined id list; splitting or reordering
    // it here would open a different conversation than the caller asked for.
    const calls: OpenArgs[] = [];
    await openDm({
      client: clientRecording(calls),
      users: "U123,U456",
    });

    expect(calls[0]?.users).toBe("U123,U456");
  });

  test("returns the Slack response so the caller can read channel.id", async () => {
    const result = await openDm({
      client: clientRecording([]),
      users: "U1",
    });

    expect(result).toEqual(Result.succeed(OPEN_RESPONSE));
  });

  test("skips the token check entirely when a client is injected", async () => {
    // The seam is what makes this module testable at all: an injected client
    // is already authenticated, so an empty env must not veto the call.
    const calls: OpenArgs[] = [];
    const result = await openDm({
      client: clientRecording(calls),
      env: {},
      users: "U1",
    });

    expect(Result.isSuccess(result)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("puts a thrown Slack error in the failure channel instead of rejecting", async () => {
    const result = await openDm({
      client: throwingClient(new Error("channel_not_found")),
      users: "U1",
    });

    expect(Result.isFailure(result)).toBe(true);
    expect(failureMessage(result)).toContain("channel_not_found");
  });
});
