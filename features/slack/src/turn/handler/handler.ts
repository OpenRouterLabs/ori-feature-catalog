/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * handler.ts — one Slack message becomes one agent turn.
 *
 * This is the seam the rest of the feature exists to serve:
 *
 *   Slack event -> gates -> thread ref -> session lookup -> chat.sendMessage
 *              -> consume AgentRuntimeEvent stream -> MessageStream -> Slack
 *
 * Two decisions from the RFC are enforced here rather than downstream.
 *
 * The prompt carries ONLY the new Slack input. Prior turns live in the agent
 * session, not in a replayed transcript — `ThreadContext.build` returns a
 * context block only on a cold start, when no session exists yet.
 *
 * Slack coordinates are threaded to the agent as ENV, not as prompt text, so
 * the `slack-api` skill can act on the current thread without the model having
 * to copy ids out of its context — and without those ids being something a
 * prompt injection can rewrite.
 */

import type { AgentRuntimeEvent, Chat } from "ori";

import { Effect, Ref, Stream } from "effect";

import { bestEffort } from "../../helpers/best-effort.ts";

import type { MessageReplyShape } from "../../message-reply/reply.ts";
import type { RunState } from "../../message-stream/run-state.ts";
import type { RunOptions } from "../../message-stream/stream.ts";
import type { StateStoreShape } from "../../state/index.ts";
import type {
  AssistantThreadsShape,
  PaneContext,
} from "../../thread/index.ts";
import type { LiveTurn } from "../../thread/index.ts";
import type { PendingApprovals, SessionSlot } from "../run-events.ts";
import type { IncomingTurn } from "../turn-input.ts";

import { Blockers } from "../../interactions/blocker.ts";
import { permissionResolvedBlocks } from "../../interactions/permissions.ts";
import { makeMessageReply } from "../../message-reply/reply-live.ts";
import { answerText } from "../../message-stream/answer-text.ts";
import { RunPhase, initialRunState } from "../../message-stream/run-state.ts";
import { MessageStream } from "../../message-stream/stream.ts";
import { StateStore } from "../../state/index.ts";
import { AssistantThreads } from "../../thread/index.ts";
import {
  hasSuccessor,
  TURN_STEER_REASON,
  TURN_TIMEOUT_REASON,
} from "../../thread/index.ts";
import { threadInstanceId, ThreadContext } from "../../thread/index.ts";
import { openPane, paneContextBlock } from "../context/pane-context.ts";
import { steerContextBlock } from "../context/steer-context.ts";
import { toolContextBlock } from "../context/tool-context.ts";
import { SLACK_REPLY_STYLE, SLACK_STYLE_REMINDER } from "../reply-style.ts";
import { retireTurn } from "../retire-turn.ts";
import { AgentStreamEnded, applyEvent, handleRunEvent } from "../run-events.ts";
import { beatStatus } from "../status-beat.ts";
import { turnEnv } from "../turn-input.ts";

/**
 * Retire any approval still on screen.
 *
 * Without this a cancelled or failed turn leaves live-looking buttons pointing
 * at a correlation id nothing will ever resolve.
 */
const retirePending = Effect.fn("Slack.turn.retirePending")(function* (
  pending: PendingApprovals,
  reply: MessageReplyShape
): Effect.fn.Return<void> {
  for (const [correlationId, entry] of pending) {
    yield* reply
      .updateBlocks(
        entry.ts,
        permissionResolvedBlocks(
          { operation: entry.operation },
          "no longer needed"
        ),
        entry.operation
      )
      .pipe(bestEffort);
    pending.delete(correlationId);
  }
});

/**
 * How a run ended, from its signal.
 *
 * A timed-out run and a user-cancelled run both surface as an aborted signal,
 * but telling someone their work was "cancelled" when nobody cancelled it
 * sends them looking for who did. This now lands on the reply itself, since
 * the Cancel affordance that used to carry it is removed when the turn ends.
 */
const endedPhase = (signal: AbortSignal): RunPhase => {
  if (!signal.aborted) {
    return RunPhase.Failed;
  }
  if (signal.reason === TURN_TIMEOUT_REASON) {
    return RunPhase.TimedOut;
  }
  return signal.reason === TURN_STEER_REASON
    ? RunPhase.Steered
    : RunPhase.Cancelled;
};

/**
 * Consume the agent's event stream to completion and return the state the run
 * ended in.
 *
 * The stream IS the turn: it ends when the run reaches a terminal event.
 * Anything that escapes without one is caught here and rendered as an ending,
 * so the thread never keeps a live-looking message for a run that is over.
 */
const consumeRun = Effect.fn("Slack.turn.consumeRun")(function* (input: {
  readonly apply: (
    change: (state: RunState) => RunState
  ) => Effect.Effect<void>;
  readonly events: AsyncIterable<AgentRuntimeEvent>;
  readonly pending: PendingApprovals;
  readonly reply: MessageReplyShape;
  readonly session: SessionSlot;
  readonly signal: AbortSignal;
  readonly store: StateStoreShape;
  readonly turn: IncomingTurn;
}): Effect.fn.Return<void> {
  // A stream because the agent's iterable is genuinely async — but pulled one
  // event at a time, so the work below stays inside the same Effect rather
  // than being run per event at a boundary the turn cannot be interrupted at.
  const events = Stream.fromAsyncIterable(
    input.events,
    (cause) => new AgentStreamEnded({ cause })
  );

  yield* Stream.runForEach(events, (event) =>
    input
      .apply((state) => applyEvent(state, event))
      .pipe(
        Effect.andThen(() =>
          handleRunEvent({
            event,
            pending: input.pending,
            reply: input.reply,
            session: input.session,
            store: input.store,
            turn: input.turn,
          })
        )
      )
  ).pipe(
    // A stream that rejects ended the run, one way or another: aborted is a
    // cancel or a timeout, anything else is a failure. `endedPhase` tells them
    // apart from the signal.
    Effect.catchCause(() =>
      input.apply((state) => ({
        ...state,
        phase: endedPhase(input.signal),
      }))
    ),
    // Lazy, and it has to be: built eagerly this would read the state as it
    // was before the run started, so the ending just computed would never be
    // rendered. An aborted signal decides the ending even when the stream
    // drained without rejecting — otherwise a turn cancelled just as it
    // finished reports success, the one thing the canceller knows is wrong.
    Effect.andThen(() =>
      input.apply((state) =>
        input.signal.aborted
          ? {
              ...state,
              phase: endedPhase(input.signal),
            }
          : state
      )
    )
  );
});

/**
 * ONE state, two writers.
 *
 * The runtime event stream and the agent's own status route both change what
 * the thread shows. When each held its own copy, a posted status rendered and
 * was then overwritten by the next event folded onto a copy that had never
 * seen it — the status appeared and then vanished.
 */
const makeApply = Effect.fn("Slack.turn.makeApply")(function* (
  advance: (next: RunState) => Effect.Effect<void>
): Effect.fn.Return<{
  readonly apply: (
    change: (state: RunState) => RunState
  ) => Effect.Effect<void>;
  readonly peek: Effect.Effect<RunState>;
}> {
  const stateRef = yield* Ref.make<RunState>({
    ...initialRunState(),
    phase: RunPhase.Running,
  });
  return {
    // The ONE state write, so naming it here is what puts every writer in the
    // trace: the event fold, the ending from a rejected stream, and the
    // ending an aborted signal decides all pass through this.
    apply: (change: (state: RunState) => RunState): Effect.Effect<void> =>
      Ref.updateAndGet(stateRef, change).pipe(
        Effect.flatMap(advance),
        Effect.withSpan("Slack.turn.applyState")
      ),
    peek: Ref.get(stateRef),
  };
});

/**
 * What a turn has to hand its replacement: the prose it wrote, and the account
 * it gave of itself. Both, because the narration is often the more useful half
 * — it says what the run had established, not just what it was drafting.
 */
const partialOf = (state: RunState): string =>
  [answerText(state), ...state.log].filter((part) => part !== "").join("\n");

/**
 * Drive one run: open the agent stream, fold each event into what the thread
 * shows, and leave the thread in a terminal state whichever way it ends.
 *
 * Returned as a callback for `MessageStream.run`, which owns the pacing of the
 * edits this produces.
 */
/**
 * Open the agent's event stream for this turn.
 *
 * `priorPartial` is what the turn this one replaced had produced: the runloop
 * composes a preamble from it, so a redirected run sees the work rather than
 * starting over (RFC 0005 run steering).
 */
const openStream = (
  input: {
    readonly existing: { readonly sessionId: string } | undefined;
    readonly live: LiveTurn;
    readonly prompt: string;
    readonly sendMessage: Chat["sendMessage"];
    readonly turn: IncomingTurn;
  },
  signal: AbortSignal
): AsyncIterable<AgentRuntimeEvent> =>
  input.sendMessage({
    env: turnEnv(input.turn),
    prompt: input.prompt,
    signal,
    ...(input.existing === undefined
      ? {}
      : { sessionId: input.existing.sessionId }),
    ...(input.turn.priorPartial === undefined
      ? {}
      : { priorPartial: input.turn.priorPartial }),
  });

const driveRun = (input: {
  readonly assistant: AssistantThreadsShape;
  readonly existing: { readonly sessionId: string } | undefined;
  readonly instanceId: string;
  readonly live: LiveTurn;
  readonly prompt: string;
  readonly reply: MessageReplyShape;
  readonly sendMessage: Chat["sendMessage"];
  readonly store: StateStoreShape;
  readonly turn: IncomingTurn;
}) =>
  Effect.fn("Slack.turn.drive")(function* (
    advance: (next: RunState) => Effect.Effect<void>
  ): Effect.fn.Return<void> {
    const { assistant, live, reply, store } = input;
    const { apply, peek } = yield* makeApply(advance);

    yield* apply((state) => state);

    // Read at the moment this turn is interrupted, so a steer can hand the
    // work to its replacement rather than throwing it away.
    live.readPartial = (): string => partialOf(Effect.runSync(peek));
    // What it was asked, so a steer can hand the correction something to
    // amend rather than a blank slate.
    live.readAsk = (): string => input.turn.text;

    // The surface says the run is alive; the agent says what it found. This
    // is the first half, and it needs nothing from the model.
    const beat = yield* beatStatus({
      assistant,
      peek,
      ref: input.turn.ref,
      threadKey: input.instanceId,
    });

    const events = openStream(input, live.signal);

    // Approval prompts posted this turn, so the message can be rewritten
    // once answered. Scoped to the turn: a correlation id is only live while
    // the run that raised it is.
    const pending: PendingApprovals = new Map();
    const session: SessionSlot = {
      current: input.existing?.sessionId,
      instanceId: input.instanceId,
    };

    yield* consumeRun({
      apply,
      events,
      pending,
      reply,
      session,
      signal: live.signal,
      store,
      turn: input.turn,
    });
    yield* beat.stop;
    yield* retirePending(pending, reply);
  });

const runOptions = (turn: IncomingTurn): RunOptions => ({
  superseded: (): boolean => hasSuccessor(threadInstanceId(turn.ref)),
  ...(turn.userId === "" ? {} : { recipientUserId: turn.userId }),
});

/**
 * What the agent is handed.
 *
 * Order matters: the attachment warning must precede the message that carries
 * the attachments, so the data boundary is set before the model reads anything
 * describing them. The house style goes first, so a long pasted message cannot
 * bury it.
 */
const promptFor = (input: {
  readonly context: string;
  readonly paneContext: PaneContext | undefined;
  readonly resuming: boolean;
  readonly turn: IncomingTurn;
}): string =>
  [
    input.resuming ? SLACK_STYLE_REMINDER : SLACK_REPLY_STYLE,
    paneContextBlock(input.paneContext),
    toolContextBlock(input.turn.ref),
    input.turn.attachmentWarning ?? "",
    input.context,
    steerContextBlock(input.turn.priorAsk),
    input.turn.text,
  ]
    .filter((part) => part !== "")
    .join("\n\n");

interface HandleTurnInput {
  readonly bridge: Chat;
  readonly live: LiveTurn;
  readonly turn: IncomingTurn;
}

export const handleTurn = Effect.fn("Slack.turn.handle")(function* (
  input: HandleTurnInput
) {
  const assistant = yield* AssistantThreads;
  const threads = yield* ThreadContext;
  const store = yield* StateStore;
  const stream = yield* MessageStream;
  const blockers = yield* Blockers;

  const instanceId = threads.instanceId(input.turn.ref);
  const existing = yield* store.getSession(instanceId);

  const paneContext = yield* openPane({
    assistant,
    firstTurn: existing === undefined,
    ref: input.turn.ref,
    text: input.turn.text,
  });

  // From here on the indicator is LIT, so from here on it has to be put out
  // whatever happens. `openPane` set it, and everything below can defect —
  // building the thread context, assembling the prompt, opening the stream.
  // A defect there is caught and logged upstream without posting anything, so
  // without this the pane sits on "is thinking…" forever next to a thread that
  // never hears back. A run that dies must not look alive.
  //
  // Safe as a finalizer because neither call fails: both are best-effort and
  // log, so a Slack blip here cannot mask the original error.
  const closeTurnOut = retireTurn({
    assistant,
    blockers,
    instanceId,
    ref: input.turn.ref,
  });

  yield* Effect.gen(function* () {
    const context = yield* threads.build({
      ...input.turn.ref,
      hasSession: existing !== undefined,
      startsThread: input.turn.startsThread,
    });

    const prompt = promptFor({
      context,
      paneContext,
      resuming: existing !== undefined,
      turn: input.turn,
    });

    const reply: MessageReplyShape = yield* makeMessageReply(input.turn.ref);
    yield* stream.run(
      reply,
      driveRun({
        assistant,
        existing,
        instanceId,
        live: input.live,
        prompt,
        reply,
        sendMessage: input.bridge.sendMessage.bind(input.bridge),
        store,
        turn: input.turn,
      }),
      runOptions(input.turn)
    );
  }).pipe(Effect.ensuring(closeTurnOut));
});
