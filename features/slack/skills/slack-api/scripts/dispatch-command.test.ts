import { describe, expect, test } from "#src/test-support/index.ts";
import { Result } from "effect";

import {
  COMMANDS,
  dispatchCommand,
  isCommand,
  usageText,
} from "./dispatch-command.ts";

const CHANNEL = { channel: "C1" };

const failureMessage = async (
  result: Promise<Result.Result<unknown, Error>>
): Promise<string> => {
  const settled = await result;
  return Result.isFailure(settled) ? settled.failure.message : "";
};

describe("isCommand", () => {
  test("accepts every command the table lists", () => {
    for (const command of COMMANDS) {
      expect(isCommand(command)).toBe(true);
    }
  });

  test("rejects the write commands this skill deliberately dropped", () => {
    expect(isCommand("chat.postMessage")).toBe(false);
    expect(isCommand("chat.update")).toBe(false);
    expect(isCommand("reactions.add")).toBe(false);
  });

  test("rejects a near miss rather than guessing", () => {
    expect(isCommand("conversations.reply")).toBe(false);
    expect(isCommand("")).toBe(false);
  });
});

describe("usageText", () => {
  test("lists every command that can actually be dispatched", () => {
    const usage = usageText();

    for (const command of COMMANDS) {
      expect(usage).toContain(command);
    }
  });
});

describe("flags a command cannot run without", () => {
  test("conversations.replies needs the thread it should read", async () => {
    const message = await failureMessage(
      dispatchCommand("conversations.replies", CHANNEL)
    );

    expect(message).toContain("--ts");
    expect(message).toContain("conversations.replies");
  });

  test("conversations.open needs the users to open a DM with", async () => {
    expect(
      await failureMessage(dispatchCommand("conversations.open", {}))
    ).toContain("--users");
  });

  test("users.mention needs the name to resolve", async () => {
    expect(await failureMessage(dispatchCommand("users.mention", {}))).toContain(
      "--name"
    );
  });
});

describe("limits that are not limits", () => {
  test("a non-numeric limit is refused before the first page is fetched", async () => {
    expect(
      await failureMessage(
        dispatchCommand("conversations.replies", {
          ...CHANNEL,
          limit: "abc",
          ts: "1700.1",
        })
      )
    ).toContain("--limit must be a positive integer");
  });

  test("a fractional limit is refused rather than rounded", async () => {
    expect(
      await failureMessage(
        dispatchCommand("conversations.history", {
          ...CHANNEL,
          limit: "1.5",
        })
      )
    ).toContain("--limit must be a non-negative integer");
  });

  test("replies refuses a zero limit, which would read nothing", async () => {
    expect(
      await failureMessage(
        dispatchCommand("conversations.replies", {
          ...CHANNEL,
          limit: "0",
          ts: "1700.1",
        })
      )
    ).toContain("positive integer");
  });

  test("history refuses a negative limit", async () => {
    expect(
      await failureMessage(
        dispatchCommand("conversations.history", {
          ...CHANNEL,
          limit: "-1",
        })
      )
    ).toContain("non-negative integer");
  });
});

describe("the env threaded into a command", () => {
  const noToken = { SLACK_CHANNEL_ID: "C-FROM-ENV" };

  test("supplies the channel when --channel is omitted", async () => {
    const result = await dispatchCommand(
      "conversations.history",
      {},
      noToken
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain("SLACK_BOT_TOKEN");
    }
  });

  test("is used instead of Bun.env, so an empty map has no channel", async () => {
    const result = await dispatchCommand("conversations.history", {}, {});
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain("No channel");
    }
  });
});
