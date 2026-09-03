import type { AgentFailure, AgentRuntimeEvent } from "ori";

import { Effect, Schema } from "effect";

import { bestEffort } from "#src/helpers/index.ts";

import type { SlackApiError } from "#src/client/client.ts";
import type { SlackBlock } from "#src/helpers/block-kit/index.ts";
import type { MessageReplyShape } from "#src/message-reply/reply.ts";
import type { RunState } from "#src/message-stream/run-state.ts";
import type { StateStoreShape } from "#src/state/store.ts";
import type { IncomingTurn } from "./turn-input.ts";

import {
  elicitationBlocks,
  permissionBlocks,
  permissionResolvedBlocks,
} from "#src/interactions/permissions.ts";
import { RunPhase } from "#src/message-stream/run-state.ts";
import {
  finishedTool,
  startedTool,
  workingTool,
} from "#src/message-stream/tool-liveness.ts";

export class AgentStreamEnded extends Schema.TaggedErrorClass<AgentStreamEnded>()(
  "AgentStreamEnded",
  { cause: Schema.Defect() }
) {
  override get message(): string {
    return `the agent event stream ended: ${String(this.cause)}`;
  }
}

const MAX_ACCUMULATED_CHARS = 45_000;

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
  CompactionCancelled: "compaction.cancelled",
  CompactionCompleted: "compaction.completed",
  CompactionFailed: "compaction.failed",
  CompactionStarted: "compaction.started",
  TurnFailed: "turn.failed",
  TurnSucceeded: "turn.succeeded",
} as const;

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

const failureText = (failure: AgentFailure): string =>
  failure.remediation === undefined
    ? failure.message
    : `${failure.message} — ${failure.remediation}`;

export const applyEvent = (
  state: RunState,
  event: AgentRuntimeEvent
): RunState => {
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
    case Tag.ToolSucceeded:
    case Tag.ToolFailed: {
      return finishedTool(withModel);
    }
    case Tag.ToolOutputDelta:
    case Tag.ToolProgress: {
      return workingTool(withModel);
    }
    case Tag.CompactionStarted: {
      return withModel.compactingSince === undefined
        ? { ...withModel, compactingSince: Date.now() }
        : withModel;
    }
    case Tag.CompactionCancelled:
    case Tag.CompactionCompleted:
    case Tag.CompactionFailed: {
      return { ...withModel, compactingSince: undefined };
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

export type PendingApprovals = Map<string, { operation: string; ts: string }>;

const unroutableApproval = (kind: string): Effect.Effect<void> =>
  Effect.logError(
    `[slack] ${kind} requested with no session id; the run cannot be unblocked`
  ).pipe(Effect.withSpan("Slack.runEvents.unroutableApproval"));

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
    yield* reply
      .updateBlocks(
        entry.ts,
        permissionResolvedBlocks({ operation: entry.operation }, outcome),
        entry.operation
      )
      .pipe(bestEffort);
    pending.delete(correlationId);
  }
);

const SessionSlotSchema = Schema.Struct({
  current: Schema.mutableKey(Schema.UndefinedOr(Schema.String)),
  instanceId: Schema.String,
});

export type SessionSlot = typeof SessionSlotSchema.Type;

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
