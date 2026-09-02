import type { ThreadRef } from "#src/thread/thread.ts";

export const toolContextBlock = (ref: ThreadRef): string =>
  [
    "<slack_thread_ref>",
    `channel: ${ref.channelId}`,
    `thread_ts: ${ref.threadTs}`,
    ref.teamId === "" ? "" : `team: ${ref.teamId}`,
    "The thread you are working in. slack-status and slack-questions already know it — do not pass it to them.",
    "</slack_thread_ref>",
  ]
    .filter((line) => line !== "")
    .join("\n");
