import { describe, expect, test } from "bun:test";

import { buildSlackThreadUrl } from "./guards.ts";

describe("buildSlackThreadUrl", () => {
  test("anchors on the thread root and links back to it", () => {
    expect(
      buildSlackThreadUrl({
        channel: "C1",
        threadTs: "1748900000.001900",
      })
    ).toBe(
      "https://openrouter.slack.com/archives/C1/p1748900000001900?thread_ts=1748900000.001900&cid=C1"
    );
  });

  test("uses a reply ts as the path anchor while still naming the root", () => {
    // Slack only reliably opens the thread side-panel for a URL that points at
    // a specific reply; the root alone lands the reader in the channel.
    const url = buildSlackThreadUrl({
      channel: "C1",
      messageTs: "1748900100.002000",
      threadTs: "1748900000.001900",
    });

    expect(url).toContain("/p1748900100002000?");
    expect(url).toContain("thread_ts=1748900000.001900");
  });

  test("an empty message ts falls back to the root rather than /p", () => {
    expect(
      buildSlackThreadUrl({
        channel: "C1",
        messageTs: "",
        threadTs: "1700.1",
      })
    ).toContain("/archives/C1/p17001?");
  });

  test("a workspace url keeps exactly one slash before /archives", () => {
    expect(
      buildSlackThreadUrl({
        channel: "C1",
        threadTs: "1700.1",
        workspaceUrl: "https://example.slack.com/",
      })
    ).toStartWith("https://example.slack.com/archives/C1/");
  });
});
