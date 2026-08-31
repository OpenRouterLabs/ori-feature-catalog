/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */

import type { ThreadRef } from "../thread/thread.ts";

export interface IncomingTurn {
  readonly attachmentWarning?: string | undefined;
  readonly priorPartial?: string | undefined;
  readonly priorAsk?: string | undefined;
  readonly ref: ThreadRef;
  readonly startsThread?: boolean | undefined;
  readonly spawnDepth?: number | undefined;
  readonly text: string;
  readonly userId: string;
}

export const turnEnv = (turn: IncomingTurn): Record<string, string> => ({
  SLACK_CHANNEL_ID: turn.ref.channelId,
  SLACK_TEAM_ID: turn.ref.teamId,
  SLACK_THREAD_TS: turn.ref.threadTs,
  SLACK_USER_ID: turn.userId,
  SPAWN_THREAD_DEPTH: String(turn.spawnDepth ?? 0),
});
