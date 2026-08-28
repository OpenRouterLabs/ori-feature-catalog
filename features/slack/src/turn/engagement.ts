/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * engagement.ts — the decision `listen.ts` describes, against real thread state.
 *
 * One entry point, because the order of these steps is the whole design:
 * a message is COUNTED before it is judged. The gates drop every bot message,
 * so asking them first would mean a second app could fill a thread without ever
 * being noticed — and another app arriving is exactly the crowd to step back
 * from.
 *
 * None of the I/O here is this file's own — the note, the two store reads and
 * the writes all arrive as `EngagementDeps`. They are Effects, so the decision
 * is one too: it runs in the fiber that asked for it, inside that fiber's
 * spans, rather than being run from a promise boundary of its own.
 */

import { Effect } from "effect";

import type { ThreadRef } from "../thread/index.ts";
import type { GateContext, IncomingMessage } from "./gates.ts";
import type { ThreadListen } from "./listen.ts";

import { admitMessage } from "./gates.ts";
import {
  addressesSomeoneElse,
  answersUnaddressed,
  engage,
  isStopRequest,
  isCrowded,
  isUnmuteRequest,
  mute,
  participantOf,
  standDown,
  UNMUTED_NOTE,
  unmute,
  withParticipant,
} from "./listen.ts";

type TurnVerdict = "run" | "drop";

/** Timestamps retained before the oldest is forgotten; a redelivery is close. */
const RECENT_STARTS = 512;

/**
 * Claim a message timestamp, true only for the first caller.
 *
 * Slack delivers a thread mention twice, in either order, so the claim belongs
 * where a turn starts — on arrival the dropped copy would swallow the mention.
 */
export const claimStart = (): ((ts: string | undefined) => boolean) => {
  const seen = new Set<string>();
  return (ts) => {
    if (ts === undefined || seen.has(ts)) {
      return false;
    }
    seen.add(ts);
    while (seen.size > RECENT_STARTS) {
      const oldest = seen.values().next().value;
      if (oldest === undefined) {
        break;
      }
      seen.delete(oldest);
    }
    return true;
  };
};

export interface EngagementDeps {
  readonly gates: GateContext;
  /** Best-effort thread note; a failed post must not fault the decision. */
  readonly note: (ref: ThreadRef, text: string) => Effect.Effect<void>;
  readonly readListen: (key: string) => Effect.Effect<ThreadListen>;
  /** Interrupt whatever is running in this thread. Synchronous: the registry
   * holds the `AbortSignal` in memory, so there is nothing to wait for. */
  readonly stop: (key: string) => void;
  readonly updateListen: (
    key: string,
    change: (state: ThreadListen) => ThreadListen
  ) => Effect.Effect<ThreadListen>;
}

export interface EngagementInput {
  /** A mention or a DM: someone asked the bot directly. */
  readonly addressed: boolean;
  readonly key: string;
  readonly message: IncomingMessage;
  readonly ref: ThreadRef;
}

/**
 * Record who is here; step back once that is more than one of them.
 *
 * Silently. The note explaining it was posted the moment a second person spoke,
 * which meant an aside between two people — often mid-run, often not addressed
 * to the bot at all — got answered by the bot talking about itself. Two agents
 * in one thread each posted their own, so a conversation between colleagues
 * collected a paragraph of surface chatter neither had asked for.
 *
 * Nothing is lost by saying nothing: the bot still answers a mention, which is
 * how anyone who wants it back gets it. `unmute` still confirms, because that
 * one answers a direct request.
 */
const observe = Effect.fn("Slack.engagement.observe")(function* (
  deps: EngagementDeps,
  input: EngagementInput
): Effect.fn.Return<ThreadListen> {
  const participant = participantOf(input.message, deps.gates);
  const state = yield* deps.updateListen(input.key, (current) =>
    withParticipant(current, participant)
  );
  if (!isCrowded(state) || state.muted) {
    return state;
  }
  return yield* deps.updateListen(input.key, mute);
});

/**
 * Whether this message starts a turn, updating what the thread remembers.
 *
 * An unanswered thread is not tracked at all, or every message in every channel
 * the bot can see would allocate state.
 */
export const considerTurn = Effect.fn("Slack.engagement.considerTurn")(
  function* (
    deps: EngagementDeps,
    input: EngagementInput
  ): Effect.fn.Return<TurnVerdict> {
    const known = yield* deps.readListen(input.key);
    if (!(input.addressed || known.engaged)) {
      return "drop";
    }

    const state = yield* observe(deps, input);
    const admitted = admitMessage(input.message, deps.gates).admit;

    if (admitted && isUnmuteRequest(input.message.text)) {
      yield* deps.updateListen(input.key, unmute);
      yield* deps.note(input.ref, UNMUTED_NOTE);
      return "drop";
    }

    if (admitted && isStopRequest(input.message.text)) {
      deps.stop(input.key);
      return "drop";
    }

    // Checked before the listen decision and only when nobody named us: a
    // mention of someone else means the thread has moved on, so hand it over
    // rather than answering into a conversation that is not ours.
    if (
      !input.addressed &&
      addressesSomeoneElse(input.message.text, deps.gates.botUserId)
    ) {
      yield* deps.updateListen(input.key, standDown);
      return "drop";
    }

    if (!(input.addressed || answersUnaddressed(state))) {
      return "drop";
    }
    if (!admitted) {
      return "drop";
    }

    yield* deps.updateListen(input.key, engage);
    return "run";
  }
);
