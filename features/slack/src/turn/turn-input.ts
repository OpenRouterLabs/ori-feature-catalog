import { Schema } from "effect";

import { ThreadRefSchema } from "#src/thread/index.ts";

export const IncomingTurnSchema = Schema.Struct({
  attachmentWarning: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  priorPartial: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  priorAsk: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  ref: ThreadRefSchema,
  startsThread: Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean)),
  spawnDepth: Schema.optionalKey(Schema.UndefinedOr(Schema.Number)),
  text: Schema.String,
  userId: Schema.String,
});

export type IncomingTurn = typeof IncomingTurnSchema.Type;

export const turnEnv = (turn: IncomingTurn): Record<string, string> => ({
  SLACK_CHANNEL_ID: turn.ref.channelId,
  SLACK_TEAM_ID: turn.ref.teamId,
  SLACK_THREAD_TS: turn.ref.threadTs,
  SLACK_USER_ID: turn.userId,
  SPAWN_THREAD_DEPTH: String(turn.spawnDepth ?? 0),
});
