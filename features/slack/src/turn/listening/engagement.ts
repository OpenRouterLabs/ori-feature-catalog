import { Effect, Schema } from "effect";

import type { ThreadRef } from "#src/thread/thread.ts";
import type { ThreadListen } from "./listen.ts";

import { functionSchema } from "#src/schema-support.ts";
import { ThreadRefSchema } from "#src/thread/thread.ts";
import {
  admitMessage,
  GateContextSchema,
  IncomingMessageSchema,
} from "./gates.ts";
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

const RECENT_STARTS = 512;

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

export const EngagementDepsSchema = Schema.Struct({
  gates: GateContextSchema,
  note: functionSchema<(ref: ThreadRef, text: string) => Effect.Effect<void>>(
    "EngagementDeps.note"
  ),
  readListen: functionSchema<(key: string) => Effect.Effect<ThreadListen>>(
    "EngagementDeps.readListen"
  ),
  stop: functionSchema<(key: string) => void>("EngagementDeps.stop"),
  updateListen: functionSchema<
    (
      key: string,
      change: (state: ThreadListen) => ThreadListen
    ) => Effect.Effect<ThreadListen>
  >("EngagementDeps.updateListen"),
});

export type EngagementDeps = typeof EngagementDepsSchema.Type;

const EngagementInputSchema = Schema.Struct({
  addressed: Schema.Boolean,
  key: Schema.String,
  message: IncomingMessageSchema,
  ref: ThreadRefSchema,
});

export type EngagementInput = typeof EngagementInputSchema.Type;

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
