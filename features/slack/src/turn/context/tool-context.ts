/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */

import type { ThreadRef } from "../../thread/thread.ts";

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
