/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * tool-context.ts — which thread the turn is happening in.
 *
 * Informational only. Every skill that writes to the thread reads these same
 * variables from its own environment, which the runtime sets per turn — so the
 * ids cannot go stale and the model never has to pass them. Asking it to was
 * friction on calls that have to be cheap enough to make mid-task.
 *
 * Kept because the skills post to other threads and want the ids in view.
 *
 * Not sanitised, because it holds nothing but ids Slack itself supplied.
 */

import type { ThreadRef } from "../../thread/index.ts";

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
