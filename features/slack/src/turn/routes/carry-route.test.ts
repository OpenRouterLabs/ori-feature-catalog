/**
 * carry-route.test.ts — the refusals.
 *
 * `carry.test.ts` covers what a successful carry does to the store. What is
 * left here is the two ways it must decline, both of which would otherwise
 * corrupt something quietly: carrying a thread mid-turn, and carrying a thread
 * that has no session behind it.
 */

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import type { CarryResult } from "../carry.ts";

import { CarryOutcome } from "../carry.ts";
import { makeCarryRoute } from "./carry-route.ts";

const CARRIED: CarryResult = {
  kind: CarryOutcome.Carried,
  sessionId: "sess-live",
};

const route = (
  overrides: {
    readonly carry?: () => Promise<CarryResult>;
    readonly isBusy?: boolean;
    readonly isStopping?: boolean;
  } = {}
): ((request: Request) => Promise<Response>) =>
  makeCarryRoute({
    carry: overrides.carry ?? ((): Promise<CarryResult> =>
      Promise.resolve(CARRIED)),
    isBusy: () => overrides.isBusy ?? false,
    isStopping: () => overrides.isStopping ?? false,
    workspaceTeamId: "T1",
  });

const post = (body: unknown): Request =>
  new Request("http://127.0.0.1/slack/thread/carry", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

const VALID = {
  channel: "C1",
  thread_ts: "1700.1",
  to_thread_ts: "1800.2",
};

describe("carrying over HTTP", () => {
  test("a valid carry reports the session it moved", async () => {
    const response = await route()(post(VALID));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sessionId: "sess-live" });
  });

  test("a thread mid-turn is refused rather than rebound underneath", async () => {
    // The origin's turn is still writing to that session; handing it to
    // another thread now is how two turns end up interleaved in one context.
    const response = await route({ isBusy: true })(post(VALID));

    expect(response.status).toBe(409);
  });

  test("a thread with no session says so instead of inventing one", async () => {
    const response = await route({
      carry: () => Promise.resolve({ kind: CarryOutcome.NothingToCarry }),
    })(post(VALID));

    expect(response.status).toBe(422);
  });

  test("a thread cannot be carried onto itself", async () => {
    const response = await route()(
      post({ ...VALID, to_thread_ts: VALID.thread_ts })
    );

    expect(response.status).toBe(400);
  });

  test.each([
    ["channel", { ...VALID, channel: "" }],
    ["thread_ts", { ...VALID, thread_ts: "" }],
    ["to_thread_ts", { ...VALID, to_thread_ts: "" }],
  ])("a missing %s is rejected", async (_field, body) => {
    expect((await route()(post(body))).status).toBe(400);
  });

  test("a shutting-down daemon refuses rather than half-moving", async () => {
    const response = await route({ isStopping: true })(post(VALID));

    expect(response.status).toBe(503);
  });

  test("nothing is carried when the request is refused", async () => {
    let called = false;
    const response = await route({
      carry: () => {
        called = true;
        return Promise.resolve(CARRIED);
      },
      isBusy: true,
    })(post(VALID));

    expect(response.status).toBe(409);
    expect(called).toBe(false);
  });
});
