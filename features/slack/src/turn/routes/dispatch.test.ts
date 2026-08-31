import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { MAX_SPAWN_DEPTH as SKILL_MAX_SPAWN_DEPTH } from "#skills/spawn-thread/scripts/spawn-thread.ts";
import { MAX_SPAWN_DEPTH, isLoopback, parseDispatchBody } from "./dispatch.ts";

const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  channel: "C1",
  message: "do the thing",
  thread_ts: "1700.0001",
  user_id: "U1",
  ...over,
});

describe("parseDispatchBody empty fields", () => {
  test.each([["channel"], ["thread_ts"]])(
    "rejects an empty %s rather than failing later at post time",
    (field) => {
      const parsed = parseDispatchBody({
        channel: "C1",
        message: "hi",
        thread_ts: "1700.1",
        [field]: "",
      });

      expect(parsed.ok).toBe(false);
    }
  );
});

describe("spawn depth parity", () => {
  test("the route and the skill agree on the ceiling", () => {
    expect(MAX_SPAWN_DEPTH).toBe(SKILL_MAX_SPAWN_DEPTH);
  });
});

describe("parseDispatchBody", () => {
  test("accepts a well-formed body", () => {
    const parsed = parseDispatchBody(body());

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.request).toEqual({
      channel: "C1",
      depth: 0,
      message: "do the thing",
      threadTs: "1700.0001",
      userId: "U1",
    });
  });

  test("defaults depth to zero when the skill omits it", () => {
    const parsed = parseDispatchBody(body({ spawn_thread_depth: undefined }));

    expect(parsed.ok && parsed.request.depth).toBe(0);
  });

  test("accepts depth at the ceiling", () => {
    const parsed = parseDispatchBody(
      body({ spawn_thread_depth: MAX_SPAWN_DEPTH })
    );

    expect(parsed.ok).toBe(true);
  });

  test("rejects depth past the ceiling so spawn chains terminate", () => {
    const parsed = parseDispatchBody(
      body({ spawn_thread_depth: MAX_SPAWN_DEPTH + 1 })
    );

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain("spawn depth");
  });

  test("treats a missing user id as anonymous rather than failing", () => {
    const parsed = parseDispatchBody(body({ user_id: undefined }));

    expect(parsed.ok && parsed.request.userId).toBeUndefined();
  });

  test("collapses an empty user id to undefined", () => {
    const parsed = parseDispatchBody(body({ user_id: "" }));

    expect(parsed.ok && parsed.request.userId).toBeUndefined();
  });

  test.each([
    ["missing channel", { channel: undefined }],
    ["missing thread_ts", { thread_ts: undefined }],
    ["missing message", { message: undefined }],
    ["numeric channel", { channel: 1 }],
  ])("rejects %s", (_label, over) => {
    expect(parseDispatchBody(body(over)).ok).toBe(false);
  });

  test("rejects an empty message rather than starting a blank turn", () => {
    expect(parseDispatchBody(body({ message: "" })).ok).toBe(false);
  });

  test("rejects a non-object body", () => {
    for (const raw of [null, undefined, "a string", 42, []]) {
      expect(parseDispatchBody(raw).ok).toBe(false);
    }
  });
});

describe("isLoopback", () => {
  test.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])(
    "admits %s",
    (address) => {
      expect(isLoopback(address)).toBe(true);
    }
  );

  test.each(["10.0.0.5", "192.168.1.1", "1.2.3.4", "::2"])(
    "rejects %s",
    (address) => {
      expect(isLoopback(address)).toBe(false);
    }
  );

  test("rejects an unknown remote address", () => {
    const unknownAddress: string | undefined = undefined;
    expect(isLoopback(unknownAddress)).toBe(false);
  });
});
