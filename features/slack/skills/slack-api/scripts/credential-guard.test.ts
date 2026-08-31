import { describe, expect, test } from "#src/test-support/effect-test.ts";
import { Result } from "effect";

import { fetchChannelHistory } from "./get-history.ts";
import { getThreadReplies } from "./get-replies.ts";
import { listUsers } from "./list-users.ts";
import { resolveUserMention } from "./mention-user.ts";
import { openDm } from "./open-dm.ts";

const NO_TOKEN = {};

const commands: readonly {
  readonly name: string;
  readonly run: () => Promise<Result.Result<unknown, Error>>;
}[] = [
  {
    name: "conversations.history",
    run: () =>
      fetchChannelHistory({
        channel: "C1",
        env: NO_TOKEN,
      }),
  },
  {
    name: "conversations.replies",
    run: () =>
      getThreadReplies({
        channel: "C1",
        env: NO_TOKEN,
        ts: "1700.1",
      }),
  },
  {
    name: "conversations.open",
    run: () =>
      openDm({
        env: NO_TOKEN,
        users: "U1",
      }),
  },
  {
    name: "users.list",
    run: () =>
      listUsers({
        env: NO_TOKEN,
      }),
  },
  {
    name: "users.mention",
    run: () =>
      resolveUserMention({
        env: NO_TOKEN,
        name: "lab",
      }),
  },
];

describe("a run with no bot token", () => {
  for (const command of commands) {
    test(`${command.name} fails with the variable it needs`, async () => {
      const result = await command.run();

      expect(Result.isFailure(result)).toBe(true);
      expect(Result.isFailure(result) && result.failure.message).toContain(
        "SLACK_BOT_TOKEN"
      );
    });
  }

  test("users.mention reports the client failure rather than no-such-user", async () => {
    const result = await resolveUserMention({
      env: NO_TOKEN,
      name: "lab",
    });

    expect(Result.isFailure(result) && result.failure.message).not.toContain(
      "No user found"
    );
  });
});
