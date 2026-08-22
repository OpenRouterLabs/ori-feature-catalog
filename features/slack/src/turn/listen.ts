/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * listen.ts — whether to answer a thread nobody addressed.
 *
 * A mention engages a thread. After that a plain reply is answered without one,
 * because making someone re-mention the bot on every message of a conversation
 * it is already holding is friction that buys nothing.
 *
 * That only holds while the thread IS a conversation with the bot. Once a
 * second participant appears — another person or another app — the bot steps
 * back rather than talking over the group: it mutes the thread, says so once,
 * and answers only explicit mentions from then on.
 */

import type { GateContext, IncomingMessage } from "./gates.ts";

import { asideOf } from "./gates.ts";

/** Distinct others a thread may hold and still be a conversation with the bot. */
const CROWD_LIMIT = 1;

/** Not the gate's ignore list: a `thread_broadcast` is a person in the room. */
const SILENT_SUBTYPES: ReadonlySet<string> = new Set([
  "channel_join",
  "channel_leave",
  "message_changed",
  "message_deleted",
]);

export interface ThreadListen {
  /** The bot has answered here, so unaddressed replies are for it. */
  readonly engaged: boolean;
  readonly muted: boolean;
  /** Distinct authors seen, never including the bot itself. */
  readonly participants: ReadonlySet<string>;
  /** An explicit `unmute` retires the heuristic for this thread. */
  readonly suppressed: boolean;
}

export const UNSEEN_THREAD: ThreadListen = {
  engaged: false,
  muted: false,
  participants: new Set(),
  suppressed: false,
};

/**
 * Who a message counts as, or `undefined` when it must not count.
 *
 * Without our own id no bot counts: under-counting other apps degrades to
 * mention-only, while counting ourselves would mute on the first reply.
 */
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
  // A webhook post carries only a `bot_id`.
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

/** True once the thread holds more people than a conversation with the bot. */
export const isCrowded = (state: ThreadListen): boolean =>
  !state.suppressed && state.participants.size > CROWD_LIMIT;

export const mute = (state: ThreadListen): ThreadListen => ({
  ...state,
  muted: true,
});

/** Opt-in to a group conversation: retires the heuristic that just fired. */
export const unmute = (state: ThreadListen): ThreadListen => ({
  ...state,
  engaged: true,
  muted: false,
  suppressed: true,
});

/** Whether a message addressed to nobody should still start a turn. */
export const answersUnaddressed = (state: ThreadListen): boolean =>
  state.engaged && !state.muted;

export const isUnmuteRequest = (text: string): boolean =>
  text.trim().toLowerCase() === "unmute";

/** Every user Slack encoded a mention for. */
const MENTIONS = /<@([A-Z0-9]+)(?:\|[^>]*)?>/gu;

/**
 * True when this message names somebody, and that somebody is not us.
 *
 * The strongest signal a message is not for you, and it is free to read.
 * "cc @lab to review too" is addressed to lab; answering it anyway is the bot
 * deciding that anything said near it is said to it.
 */
export const addressesSomeoneElse = (
  text: string,
  botUserId: string | undefined
): boolean => {
  // Without our own id every mention reads as someone else's, including ours,
  // so the bot would stand down on being addressed. Same rule as the crowd
  // tally: when it cannot tell, it does not act.
  if (botUserId === undefined) {
    return false;
  }
  const named = [...text.matchAll(MENTIONS)].map(([, id]) => id);
  return named.length > 0 && !named.includes(botUserId);
};

/**
 * Hand the thread over.
 *
 * Not a mute: the bot is not stepping back from a crowd, it is recognising
 * that the last thing said was said to someone else. A mention brings it back,
 * and the crowd heuristic is left armed rather than retired.
 */
export const standDown = (state: ThreadListen): ThreadListen => ({
  ...state,
  engaged: false,
});

/**
 * Devin's idiom: you stop an agent by telling it to stop.
 *
 * A phrase, not a word. The set was matched EXACTLY, so "cancel" stopped a run
 * and "cancel this run" did not — and with no button any more, that left no
 * way at all to stop one.
 *
 * Still deliberately tight. "cancel this run" is a stop; "cancel the deploy
 * PR" is a task, and reading it as a stop would be worse than missing it.
 */
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
