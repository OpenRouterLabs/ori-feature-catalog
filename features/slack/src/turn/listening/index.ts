/**
 * index.ts — whether a message is for the bot at all.
 *
 * `gates.ts` is the deterministic part, `listen.ts` the per-thread memory of
 * who is talking, and `engagement.ts` the judgement built on both. One unit
 * because the chain only runs in that order.
 */

export type { EngagementDeps, EngagementInput } from "./engagement.ts";
export { claimStart, considerTurn } from "./engagement.ts";
export type { GateContext, IncomingMessage } from "./gates.ts";
export { admitMessage, asideOf, gateContextOf } from "./gates.ts";
export type { ThreadListen } from "./listen.ts";
export {
  addressesSomeoneElse,
  answersUnaddressed,
  engage,
  isCrowded,
  isStopRequest,
  isUnmuteRequest,
  mute,
  participantOf,
  standDown,
  UNMUTED_NOTE,
  unmute,
  UNSEEN_THREAD,
  withParticipant,
} from "./listen.ts";
