/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * turn-input.ts — what a turn was asked, and what the agent is handed.
 *
 * Neither of these is an event, which is why they are not in `run-events.ts`.
 * This is the turn's input CONTRACT: the routes and the Slack listener build
 * it, the handler consumes it, and the event fold never looks at it. Sitting
 * beside the fold meant `handler.ts` imported its own input type out of the
 * module that decodes runtime output.
 */

import type { ThreadRef } from "../thread/index.ts";

export interface IncomingTurn {
  /** Warning block for any attachments on the message; "" when there are none. */
  readonly attachmentWarning?: string | undefined;
  /**
   * What the turn this one replaced had produced, when a new message steered
   * a running turn rather than queueing behind it.
   */
  readonly priorPartial?: string | undefined;
  /** What the turn this one replaced was asked, when this turn steered one. */
  readonly priorAsk?: string | undefined;
  readonly ref: ThreadRef;
  /**
   * True when this message opened the thread, so there is no history to read.
   * Skipping that read takes a rate-limited call off the front of a cold start.
   */
  readonly startsThread?: boolean | undefined;
  /**
   * How many spawns deep this turn is. A turn started by a Slack event is 0;
   * one started over the dispatch route carries the depth the caller sent.
   */
  readonly spawnDepth?: number | undefined;
  readonly text: string;
  readonly userId: string;
}

/**
 * Env handed to the spawned agent. The `slack-api` skill reads these first, so
 * a reply lands in the right thread without the model restating ids.
 */
export const turnEnv = (turn: IncomingTurn): Record<string, string> => ({
  SLACK_CHANNEL_ID: turn.ref.channelId,
  SLACK_TEAM_ID: turn.ref.teamId,
  SLACK_THREAD_TS: turn.ref.threadTs,
  SLACK_USER_ID: turn.userId,
  // The spawn-thread skill refuses to recurse past MAX_SPAWN_DEPTH by reading
  // this. Left unset, its guard reads `Number(undefined ?? "0")` — zero — so
  // every spawned turn restarted the count and the cap never engaged.
  SPAWN_THREAD_DEPTH: String(turn.spawnDepth ?? 0),
});
