/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */

import type { AgentRuntimeEvent, Chat } from "ori";

import { Effect, Ref, Stream } from "effect";

import { bestEffort } from "../../helpers/best-effort.ts";

import type { MessageReplyShape } from "../../message-reply/reply.ts";
import type { RunState } from "../../message-stream/run-state.ts";
import type { RunOptions } from "../../message-stream/stream.ts";
import type { StateStoreShape } from "../../state/store.ts";
import type {
  AssistantThreadsShape,
  PaneContext,
} from "../../thread/assistant.ts";
import type { LiveTurn } from "../../thread/registry.ts";
import type { PendingApprovals, SessionSlot } from "../run-events.ts";
import type { IncomingTurn } from "../turn-input.ts";

import { Blockers } from "../../interactions/blocker.ts";
import { permissionResolvedBlocks } from "../../interactions/permissions.ts";
import { makeMessageReply } from "../../message-reply/reply-live.ts";
import { answerText } from "../../message-stream/answer-text.ts";
import { RunPhase, initialRunState } from "../../message-stream/run-state.ts";
import { MessageStream } from "../../message-stream/stream.ts";
import { StateStore } from "../../state/store.ts";
import { AssistantThreads } from "../../thread/assistant.ts";
import {
  hasSuccessor,
  TURN_STEER_REASON,
  TURN_TIMEOUT_REASON,
} from "../../thread/registry.ts";
import { threadInstanceId, ThreadContext } from "../../thread/thread.ts";
import { openPane, paneContextBlock } from "../context/pane-context.ts";
import { steerContextBlock } from "../context/steer-context.ts";
import { toolContextBlock } from "../context/tool-context.ts";
import { SLACK_REPLY_STYLE, SLACK_STYLE_REMINDER } from "../reply-style.ts";
import { retireTurn } from "../retire-turn.ts";
import { AgentStreamEnded, applyEvent, handleRunEvent } from "../run-events.ts";
import { beatStatus } from "../status-beat.ts";
import { turnEnv } from "../turn-input.ts";

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
    Effect.catchCause(() =>
      input.apply((state) => ({
        ...state,
        phase: endedPhase(input.signal),
      }))
    ),
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
    apply: (change: (state: RunState) => RunState): Effect.Effect<void> =>
      Ref.updateAndGet(stateRef, change).pipe(
        Effect.flatMap(advance),
        Effect.withSpan("Slack.turn.applyState")
      ),
    peek: Ref.get(stateRef),
  };
});

const partialOf = (state: RunState): string =>
  [answerText(state), ...state.log].filter((part) => part !== "").join("\n");

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

    live.readPartial = (): string => partialOf(Effect.runSync(peek));
    live.readAsk = (): string => input.turn.text;

    const beat = yield* beatStatus({
      assistant,
      peek,
      ref: input.turn.ref,
      threadKey: input.instanceId,
    });

    const events = openStream(input, live.signal);

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
