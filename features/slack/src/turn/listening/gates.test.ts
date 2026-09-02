/* oxlint-disable typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/max-lines-per-function eslint/require-await eslint/no-unsafe-optional-chaining typescript/no-invalid-void-type promise/avoid-new promise/param-names unicorn/consistent-function-scoping -- test doubles assert on recorded `unknown` args and stand in for Slack SDK shapes; cases read better whole than split */
import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { type GateContext, type IncomingMessage, admitMessage, gateContextOf } from "./gates.ts";

import { readSlackConfig } from "#src/config.ts";

const readGateContext = (
  env: Readonly<Record<string, string | undefined>>
): ReturnType<typeof gateContextOf> =>
  gateContextOf(
    readSlackConfig({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_SIGNING_SECRET: "secret",
      ...env,
    })
  );

const message = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  botId: undefined,
  subtype: undefined,
  text: "hello",
  userId: "U_HUMAN",
  ...over,
});

const context = (over: Partial<GateContext> = {}): GateContext => ({
  allowedUserIds: new Set(),
  botUserId: "U_BOT",
  skipPrefixes: [],
  ...over,
});

describe("admitMessage", () => {
  test("admits an ordinary human message", () => {
    expect(admitMessage(message(), context())).toEqual({ admit: true });
  });

  describe("loop protection", () => {
    test("rejects our own message", () => {
      expect(admitMessage(message({ userId: "U_BOT" }), context())).toEqual({
        admit: false,
        reason: "self",
      });
    });

    test("rejects any other app", () => {
      expect(
        admitMessage(
          message({
            botId: "B123",
            userId: "U_OTHER",
          }),
          context()
        )
      ).toEqual({
        admit: false,
        reason: "bot",
      });
    });

    test("still admits a human when this app has no known bot user id", () => {
      expect(
        admitMessage(message(), context({ botUserId: undefined }))
      ).toEqual({ admit: true });
    });
  });

  describe("non-turn events", () => {
    test.each([
      "channel_join",
      "channel_leave",
      "message_changed",
      "message_deleted",
      "thread_broadcast",
    ])("rejects subtype %s", (subtype) => {
      expect(admitMessage(message({ subtype }), context())).toEqual({
        admit: false,
        reason: `subtype:${subtype}`,
      });
    });

    test("admits an unknown subtype rather than guessing", () => {
      expect(
        admitMessage(message({ subtype: "file_share" }), context())
      ).toEqual({ admit: true });
    });

    test.each(["", "   ", "\n\t "])("rejects blank text %p", (text) => {
      expect(admitMessage(message({ text }), context())).toEqual({
        admit: false,
        reason: "empty",
      });
    });
  });

  describe("skip prefixes", () => {
    test("rejects a message starting with a configured prefix", () => {
      expect(
        admitMessage(
          message({ text: "//scratch note" }),
          context({ skipPrefixes: ["//"] })
        )
      ).toEqual({
        admit: false,
        reason: "prefix://",
      });
    });

    test("ignores leading whitespace when matching", () => {
      expect(
        admitMessage(
          message({ text: "   //scratch" }),
          context({ skipPrefixes: ["//"] })
        )
      ).toEqual({
        admit: false,
        reason: "prefix://",
      });
    });

    test("does not match a prefix appearing mid-message", () => {
      expect(
        admitMessage(
          message({ text: "see http://example.com" }),
          context({ skipPrefixes: ["//"] })
        )
      ).toEqual({ admit: true });
    });
  });

  describe("allowlist", () => {
    test("an empty allowlist means unrestricted", () => {
      expect(admitMessage(message({ userId: "U_ANYONE" }), context())).toEqual({
        admit: true,
      });
    });

    test("admits a listed user", () => {
      expect(
        admitMessage(
          message({ userId: "U_OK" }),
          context({ allowedUserIds: new Set(["U_OK"]) })
        )
      ).toEqual({ admit: true });
    });

    test("rejects an unlisted user", () => {
      expect(
        admitMessage(
          message({ userId: "U_NOPE" }),
          context({ allowedUserIds: new Set(["U_OK"]) })
        )
      ).toEqual({
        admit: false,
        reason: "not-allowed",
      });
    });

    test("rejects an anonymous message when an allowlist is set", () => {
      expect(
        admitMessage(
          message({ userId: undefined }),
          context({ allowedUserIds: new Set(["U_OK"]) })
        )
      ).toEqual({
        admit: false,
        reason: "not-allowed",
      });
    });
  });

  describe("precedence", () => {
    test("self wins over an allowlist that would also reject", () => {
      expect(
        admitMessage(
          message({ userId: "U_BOT" }),
          context({ allowedUserIds: new Set(["U_OK"]) })
        )
      ).toEqual({
        admit: false,
        reason: "self",
      });
    });

    test("subtype wins over emptiness", () => {
      expect(
        admitMessage(
          message({
            subtype: "message_changed",
            text: "",
          }),
          context()
        )
      ).toEqual({
        admit: false,
        reason: "subtype:message_changed",
      });
    });
  });
});

describe("readGateContext", () => {
  test("parses comma-separated lists and trims entries", () => {
    const parsed = readGateContext({
      SLACK_ALLOWED_USER_IDS: " U1 , U2,U3 ",
      SLACK_BOT_USER_ID: "U_BOT",
      SLACK_SKIP_PREFIXES: "//, #",
    });

    expect([...parsed.allowedUserIds].toSorted()).toEqual(["U1", "U2", "U3"]);
    expect(parsed.skipPrefixes).toEqual(["//", "#"]);
    expect(parsed.botUserId).toBe("U_BOT");
  });

  test("absent env yields an unrestricted context", () => {
    const parsed = readGateContext({});

    expect(parsed.allowedUserIds.size).toBe(0);
    expect(parsed.skipPrefixes).toEqual([]);
    expect(parsed.botUserId).toBeUndefined();
  });

  test("drops empty entries rather than creating a blank prefix", () => {
    const parsed = readGateContext({ SLACK_SKIP_PREFIXES: "//,,  ," });

    expect(parsed.skipPrefixes).toEqual(["//"]);
  });
});
