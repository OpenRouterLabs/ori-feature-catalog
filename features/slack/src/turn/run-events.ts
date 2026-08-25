/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * run-events.ts — reading the agent's event stream, and what each event does
 * to the thread.
 *
 * Split from `handler.ts` so that file stays about the SHAPE of a turn — build
 * the prompt, open the stream, render the ending — while this one owns the
 * per-event detail: decoding untyped payloads, posting and retiring approvals,
 * and recording the session.
 *
 * The decoders are defensive on purpose. These payloads cross a process
 * boundary from the agent runtime, so a missing or wrongly-typed field must
 * degrade the surface rather than throw inside the turn loop.
 */

import type { AgentFailure, AgentRuntimeEvent } from "ori";

import { Effect, Schema } from "effect";

import type { SlackApiError } from "../client/client.ts";
import type { SlackBlock } from "../helpers/block-kit/blocks.ts";
import type { MessageReplyShape } from "../message-reply/reply.ts";
import type { RunState } from "../message-stream/run-state.ts";
import type { StateStoreShape } from "../state/store.ts";
import type { IncomingTurn } from "./turn-input.ts";

import {
  elicitationBlocks,
  permissionBlocks,
  permissionResolvedBlocks,
} from "../interactions/permissions.ts";
import { RunPhase } from "../message-stream/run-state.ts";
import {
  finishedTool,
  startedTool,
  workingTool,
} from "../message-stream/tool-liveness.ts";

/**
 * The agent's event stream stopped before the run reached a terminal event.
 *
 * Typed rather than a bare `Error` so the turn loop that catches it can tell a
 * dead stream from a Slack call that failed inside an event handler.
 */
export class AgentStreamEnded extends Schema.TaggedErrorClass<AgentStreamEnded>()(
  "AgentStreamEnded",
  { cause: Schema.Defect() }
) {
  override get message(): string {
    return `the agent event stream ended: ${String(this.cause)}`;
  }
}

/**
 * Ceiling on accumulated prose.
 *
 * The reply is capped at the Slack boundary anyway, so anything past this can
 * never be rendered — holding it only grows the turn's memory for the length
 * of a long run.
 */
const MAX_ACCUMULATED_CHARS = 45_000;

/**
 * Event tags this surface reacts to. Everything else is progress noise.
 *
 * A deliberate SUBSET: the payload predicates below narrow off these members,
 * and widening it to the runtime's full union breaks that. The cost is that an
 * untranscribed tag is invisible here — which is how the watchdogs came to
 * miss every tool event but `started`, and read slow work as death.
 */
const Tag = {
  AssistantTextDelta: "assistant.text.delta",
  ElicitationRequested: "elicitation.requested",
  PermissionRequested: "permission.requested",
  ElicitationResolved: "elicitation.resolved",
  PermissionResolved: "permission.resolved",
  SessionFailed: "session.failed",
  SessionStarted: "session.started",
  ToolFailed: "tool.failed",
  ToolOutputDelta: "tool.output.delta",
  ToolProgress: "tool.progress",
  ToolStarted: "tool.started",
  ToolSucceeded: "tool.succeeded",
  TurnFailed: "turn.failed",
  TurnSucceeded: "turn.succeeded",
} as const;

/**
 * How an approval was answered, for the retired message.
 *
 * `permission.resolved` reports a chosen option or a cancellation;
 * `elicitation.resolved` reports an action. Both reduce to one human phrase.
 */
const readOutcome = (
  event: Extract<
    AgentRuntimeEvent,
    { type: typeof Tag.ElicitationResolved | typeof Tag.PermissionResolved }
  >
): string => {
  if (event.type === Tag.ElicitationResolved) {
    return event.payload.action;
  }
  return event.payload.outcome === "selected"
    ? event.payload.optionId.replaceAll("_", " ")
    : event.payload.outcome;
};

/**
 * What the thread shows for a failed run.
 *
 * `AgentFailure.message` is already a sanitized, display-safe summary — the
 * contract guarantees it is not a raw upstream payload — so it can go straight
 * into a Slack message. `remediation` is appended when the runtime can name a
 * next action, because "what do I do now" is the first thing the person who
 * asked will want.
 */
const failureText = (failure: AgentFailure): string =>
  failure.remediation === undefined
    ? failure.message
    : `${failure.message} — ${failure.remediation}`;

/** Fold one runtime event into the rendered run state. */
export const applyEvent = (
  state: RunState,
  event: AgentRuntimeEvent
): RunState => {
  // The engine stamps `harness` and `model` on every observed event, so the
  // first one to carry each names it for the rest of the run. `model` was on
  // the state and never set, which is why the footer never showed one.
  const named =
    state.model === undefined && typeof event.model === "string"
      ? {
          ...state,
          model: event.model,
        }
      : state;
  const withModel =
    named.harness === undefined && typeof event.harness === "string"
      ? {
          ...named,
          harness: event.harness,
        }
      : named;
  // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- the runtime emits far more than a thread needs to show; the default arm is the point
  switch (event.type) {
    case Tag.AssistantTextDelta: {
      return {
        ...withModel,
        text:
          state.text.length >= MAX_ACCUMULATED_CHARS
            ? state.text
            : state.text + event.payload.delta,
      };
    }
    case Tag.ToolStarted: {
      return startedTool(withModel, event.payload.name);
    }
    // Nothing to SHOW for these; they exist so the watchdogs can tell a run
    // doing slow work from a dead one. See `tool-liveness.ts`.
    case Tag.ToolSucceeded:
    case Tag.ToolFailed: {
      return finishedTool(withModel);
    }
    case Tag.ToolOutputDelta:
    case Tag.ToolProgress: {
      return workingTool(withModel);
    }
    case Tag.TurnSucceeded: {
      return {
        ...withModel,
        phase: RunPhase.Done,
      };
    }
    case Tag.TurnFailed:
    case Tag.SessionFailed: {
      return {
        ...withModel,
        error: failureText(event.payload.failure),
        phase: RunPhase.Failed,
      };
    }
    default: {
      return withModel;
    }
  }
};

/** Approval prompts posted this turn, keyed by correlation id. */
export type PendingApprovals = Map<string, { operation: string; ts: string }>;

/**
 * Without a session id `respondInteraction` has nowhere to route an answer, so
 * buttons would be decorative — better to surface nothing than an approval that
 * cannot be given. But the agent is now blocked on an answer that will never
 * arrive, and the turn then ends as a deadline expiry indistinguishable from a
 * genuinely slow run. This log is the only way to tell the two apart.
 */
const unroutableApproval = (kind: string): Effect.Effect<void> =>
  Effect.logError(
    `[slack] ${kind} requested with no session id; the run cannot be unblocked`
  );

/**
 * Post an approval request and remember it, so it can be retired once answered.
 *
 * Posted as a SEPARATE message rather than an edit, so the streaming reply's
 * update pacing does not fight with it and the buttons survive the run's own
 * updates.
 */
const postApproval = Effect.fn("Slack.runEvents.postApproval")(
  function* (input: {
    readonly blocks: readonly SlackBlock[];
    readonly correlationId: string;
    readonly fallback: string;
    readonly operation: string;
    readonly pending: PendingApprovals;
    readonly reply: MessageReplyShape;
  }): Effect.fn.Return<void, SlackApiError> {
    const posted = yield* input.reply.replyBlocks(input.blocks, input.fallback);
    input.pending.set(input.correlationId, {
      operation: input.operation,
      ts: posted.ts,
    });
  }
);

/**
 * Retire an answered approval. Leaving the buttons clickable invites a second
 * answer to a request that is already closed.
 */
const retireApproval = Effect.fn("Slack.runEvents.retireApproval")(
  function* (input: {
    readonly correlationId: string;
    readonly outcome: string;
    readonly pending: PendingApprovals;
    readonly reply: MessageReplyShape;
  }): Effect.fn.Return<void> {
    const { correlationId, outcome, pending, reply } = input;
    const entry = pending.get(correlationId);
    if (entry === undefined) {
      return;
    }
    // Ignored, not propagated: the buttons are already answered, so a failed
    // rewrite costs some tidiness and must not end the run.
    yield* reply
      .updateBlocks(
        entry.ts,
        permissionResolvedBlocks({ operation: entry.operation }, outcome),
        entry.operation
      )
      .pipe(Effect.ignore);
    pending.delete(correlationId);
  }
);

/**
 * The session id, which `session.started` supplies part-way through a run.
 * Mutable because the events that need it can arrive either side of it.
 */
export interface SessionSlot {
  current: string | undefined;
  readonly instanceId: string;
}

/** Ask for approval of a gated operation, and remember the ask. */
const requestPermission = Effect.fn("Slack.runEvents.requestPermission")(
  function* (input: {
    readonly event: Extract<
      AgentRuntimeEvent,
      { type: typeof Tag.PermissionRequested }
    >;
    readonly pending: PendingApprovals;
    readonly reply: MessageReplyShape;
    readonly session: SessionSlot;
    readonly turn: IncomingTurn;
  }): Effect.fn.Return<void, SlackApiError> {
    const { correlationId, operation, options } = input.event.payload;
    const sessionId = input.event.payload.sessionId ?? input.session.current;
    if (sessionId === undefined) {
      yield* unroutableApproval("permission");
      return;
    }
    yield* postApproval({
      blocks: permissionBlocks({
        askedBy: input.turn.userId,
        correlationId,
        operation,
        options,
        sessionId,
      }),
      correlationId,
      fallback: `Permission needed: ${operation}`,
      operation,
      pending: input.pending,
      reply: input.reply,
    });
  }
);

/** Ask for structured input, and remember the ask. */
const requestElicitation = Effect.fn("Slack.runEvents.requestElicitation")(
  function* (input: {
    readonly event: Extract<
      AgentRuntimeEvent,
      { type: typeof Tag.ElicitationRequested }
    >;
    readonly pending: PendingApprovals;
    readonly reply: MessageReplyShape;
    readonly session: SessionSlot;
    readonly turn: IncomingTurn;
  }): Effect.fn.Return<void, SlackApiError> {
    const { correlationId, message } = input.event.payload;
    const sessionId = input.event.payload.sessionId ?? input.session.current;
    if (sessionId === undefined) {
      yield* unroutableApproval("elicitation");
      return;
    }
    yield* postApproval({
      blocks: elicitationBlocks({
        askedBy: input.turn.userId,
        correlationId,
        message,
        sessionId,
      }),
      correlationId,
      fallback: "Input requested",
      operation: message,
      pending: input.pending,
      reply: input.reply,
    });
  }
);

/**
 * React to one runtime event.
 *
 * Everything that changes what the THREAD shows lives here — approvals posted
 * and retired, the session recorded. Folding an event into the rendered run
 * state is `applyEvent`'s separate job.
 *
 * The failure is typed and propagated rather than killed at a boundary: the
 * caller consuming the stream is the one that knows what a dead run should
 * render as.
 */
export const handleRunEvent = Effect.fn("Slack.runEvents.handle")(
  function* (input: {
    readonly event: AgentRuntimeEvent;
    readonly pending: PendingApprovals;
    readonly reply: MessageReplyShape;
    readonly session: SessionSlot;
    readonly store: StateStoreShape;
    readonly turn: IncomingTurn;
  }): Effect.fn.Return<void, SlackApiError> {
    const { event, pending, reply, session, store, turn } = input;

    // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- as above: only the events that change what the thread shows are handled here
    switch (event.type) {
      case Tag.SessionStarted: {
        const { sessionId } = event.payload;
        if (sessionId !== undefined) {
          session.current = sessionId;
          yield* store.putSession(session.instanceId, {
            sessionId,
            startedAt: Date.now(),
          });
        }
        break;
      }

      case Tag.PermissionRequested: {
        yield* requestPermission({ event, pending, reply, session, turn });
        break;
      }

      case Tag.ElicitationRequested: {
        yield* requestElicitation({ event, pending, reply, session, turn });
        break;
      }

      case Tag.PermissionResolved:
      case Tag.ElicitationResolved: {
        yield* retireApproval({
          correlationId: event.payload.correlationId,
          outcome: readOutcome(event),
          pending,
          reply,
        });
        break;
      }

      default: {
        break;
      }
    }
  }
);
