import { Schema } from "effect";

import { type GateContext, type IncomingMessage, asideOf } from "./gates.ts";


const CROWD_LIMIT = 1;

const SILENT_SUBTYPES: ReadonlySet<string> = new Set([
  "channel_join",
  "channel_leave",
  "message_changed",
  "message_deleted",
]);

const ThreadListenSchema = Schema.Struct({
  engaged: Schema.Boolean,
  muted: Schema.Boolean,
  participants: Schema.ReadonlySet(Schema.String),
  suppressed: Schema.Boolean,
});

export type ThreadListen = typeof ThreadListenSchema.Type;

export const UNSEEN_THREAD: ThreadListen = {
  engaged: false,
  muted: false,
  participants: new Set(),
  suppressed: false,
};

export const participantOf = (
  message: IncomingMessage,
  context: GateContext
): string | undefined => {
  if (message.subtype !== undefined && SILENT_SUBTYPES.has(message.subtype)) {
    return undefined;
  }
  if (asideOf(message.text, context.skipPrefixes) !== undefined) {
    return undefined;
  }
  if (context.botUserId === undefined) {
    return message.botId === undefined ? message.userId : undefined;
  }
  if (message.userId === context.botUserId) {
    return undefined;
  }
  return message.userId ?? message.botId;
};

export const withParticipant = (
  state: ThreadListen,
  participant: string | undefined
): ThreadListen =>
  participant === undefined || state.participants.has(participant)
    ? state
    : {
        ...state,
        participants: new Set(state.participants).add(participant),
      };

export const engage = (state: ThreadListen): ThreadListen =>
  state.engaged
    ? state
    : {
        ...state,
        engaged: true,
      };

export const isCrowded = (state: ThreadListen): boolean =>
  !state.suppressed && state.participants.size > CROWD_LIMIT;

export const mute = (state: ThreadListen): ThreadListen => ({
  ...state,
  muted: true,
});

export const unmute = (state: ThreadListen): ThreadListen => ({
  ...state,
  engaged: true,
  muted: false,
  suppressed: true,
});

export const answersUnaddressed = (state: ThreadListen): boolean =>
  state.engaged && !state.muted;

export const isUnmuteRequest = (text: string): boolean =>
  text.trim().toLowerCase() === "unmute";

const MENTIONS = /<@([A-Z0-9]+)(?:\|[^>]*)?>/gu;

export const addressesSomeoneElse = (
  text: string,
  botUserId: string | undefined
): boolean => {
  if (botUserId === undefined) {
    return false;
  }
  const named = [...text.matchAll(MENTIONS)].map(([, id]) => id);
  return named.length > 0 && !named.includes(botUserId);
};

export const standDown = (state: ThreadListen): ThreadListen => ({
  ...state,
  engaged: false,
});

const STOP_REQUEST =
  /^(?:stop|cancel|abort|nevermind|never mind)(?:\s+(?:it|that|this|the|run|please|now))*$/u;

export const isStopRequest = (text: string): boolean =>
  STOP_REQUEST.test(
    text
      .trim()
      .toLowerCase()
      .replace(/[!.]+$/u, "")
  );

export const UNMUTED_NOTE = "Following along again — no need to mention me.";
