/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * carry.ts — move a live conversation onto a new Slack thread.
 *
 * Not a spawn. `spawn-thread new` opens a thread and lets the daemon mint a
 * fresh session for it, so the new thread starts with no memory of anything.
 * That is right when the work is genuinely separate and wrong when a person
 * asks to keep talking somewhere else: they mean this conversation, with what
 * it already knows, at a new address.
 *
 * The whole operation is a rebinding of `instanceId -> sessionId`. Nothing is
 * summarised and no session is created, because it is the same session.
 *
 * Two rules make it correct, and both are the kind that look optional until
 * they are violated:
 *
 * The binding MOVES rather than being copied. Two threads bound to one session
 * would each get their own queue — the turn registry serialises per thread key,
 * not per session — so two turns could interleave writes into one agent
 * context. That is corruption, not an inconvenience.
 *
 * The old thread is MUTED, not merely released. Clearing its session alone
 * leaves it engaged with nothing behind it, so the next reply there cold-starts
 * a fresh session and the bot reads as having amnesia rather than having moved.
 */

import { Effect } from "effect";

import type { ThreadRef } from "../thread/index.ts";

import { StateStore } from "../state/index.ts";
import { threadInstanceId } from "../thread/index.ts";
import { engage, mute } from "./listen.ts";

export const CarryOutcome = {
  /** Moved. The new thread now owns the session. */
  Carried: "carried",
  /** The origin thread has never run a turn, so there is nothing to move. */
  NothingToCarry: "nothing-to-carry",
} as const;

export type CarryOutcome = (typeof CarryOutcome)[keyof typeof CarryOutcome];

export type CarryResult =
  | { readonly kind: typeof CarryOutcome.Carried; readonly sessionId: string }
  | { readonly kind: typeof CarryOutcome.NothingToCarry };

/**
 * Move the origin thread's session onto the destination thread.
 *
 * `startedAt` is preserved rather than restamped: it records when the
 * conversation began, not when it last changed address, and the dashboard
 * sorts on it — a carried thread that restamped would sort as brand new.
 */
export const carrySession = Effect.fn("Slack.carry.session")(function* (input: {
  readonly from: ThreadRef;
  readonly to: ThreadRef;
}) {
  // Asked for rather than handed in: this runs inside the graph the turn
  // routes already carry, so reaching into the context by hand at the call
  // site would be doing the layer's job for it.
  const store = yield* StateStore;
  const fromId = threadInstanceId(input.from);
  const toId = threadInstanceId(input.to);

  const session = yield* store.getSession(fromId);
  if (session === undefined) {
    return { kind: CarryOutcome.NothingToCarry };
  }

  // Bind the destination BEFORE releasing the origin. If the process dies
  // between the two, a thread bound twice is recoverable by carrying again;
  // a session bound to nothing is a conversation nobody can reach.
  yield* store.putSession(toId, session);
  yield* store.clearSession(fromId);

  yield* store.updateListen(toId, engage);
  yield* store.updateListen(fromId, mute);

  return {
    kind: CarryOutcome.Carried,
    sessionId: session.sessionId,
  };
});
