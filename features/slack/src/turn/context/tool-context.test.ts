import { describe, expect, test } from "#src/test-support/index.ts";

import { toolContextBlock } from "./tool-context.ts";

describe("the thread ref the status skill needs", () => {
  test("names the channel and thread, and says not to pass them", () => {
    const block = toolContextBlock({
      channelId: "C123",
      teamId: "T123",
      threadTs: "1700.0001",
    });

    expect(block).toContain("channel: C123");
    expect(block).toContain("thread_ts: 1700.0001");
    expect(block).toContain("team: T123");
    expect(block).toContain("slack-status");
  });

  test("omits the team rather than printing an empty one", () => {
    const block = toolContextBlock({
      channelId: "C123",
      teamId: "",
      threadTs: "1700.0001",
    });

    expect(block).not.toContain("team:");
  });
});
