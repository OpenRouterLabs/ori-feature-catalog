/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * listeners.ts — wiring Bolt's listeners to the turn path.
 *
 * Split from `index.ts` so the composition root stays about building the graph
 * and this file owns the one rule that governs every listener:
 *
 *   A listener MUST NOT await the turn.
 *
 * Bolt resolves `processEvent` only once every listener has returned, and the
 * receiver answers Slack only once `processEvent` resolves — so awaiting here
 * holds Slack's HTTP request open for the entire agent run. Slack gives that
 * request three seconds before it calls the delivery failed and retries, and it
 * disables an endpoint that keeps failing. Worse, a second message in a live
 * thread queues behind the first, so its request would hang for both turns.
 *
 * Detaching restores the contract the receiver documents: admit the event,
 * answer 200 immediately, run the turn on its own.
 */

import type { App } from "@slack/bolt";

import type {
  InteractionPayload,
  ViewSubmissionPayload,
} from "../interactions/interactions.ts";

/**
 * `assistant_thread_started` and `assistant_thread_context_changed`, narrowed.
 *
 * One shape for both: they carry the same `assistant_thread` object, and
 * `context` is what changes between them — which conversation the reader is
 * looking at behind the pane.
 */
export interface RawAssistantThreadStarted {
  readonly assistant_thread?: {
    readonly channel_id?: string;
    readonly context?: {
      readonly channel_id?: string;
      readonly team_id?: string;
    };
    readonly thread_ts?: string;
  };
}

/** Slack's raw event shape, narrowed to the fields the gates and turn read. */
export interface RawSlackMessage {
  readonly bot_id?: string;
  readonly channel?: string;
  readonly channel_type?: string;
  readonly subtype?: string;
  readonly team?: string;
  readonly text?: string;
  readonly thread_ts?: string;
  readonly ts?: string;
  readonly user?: string;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? { ...value } : {};

const readString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** `id` off a `{ id }` wrapper, which is how Slack nests channel and user. */
const readNestedId = (value: unknown): string | undefined =>
  readString(asRecord(value).id);

/**
 * Project a Bolt action body onto the shape the interactions router needs.
 *
 * Bolt types `body` as a wide union across every interactivity kind, so this
 * reads the handful of fields that matter rather than asserting the union into
 * one member.
 */
export const readInteractionPayload = (body: unknown): InteractionPayload => {
  const record = asRecord(body);
  const actions = Array.isArray(record.actions) ? record.actions : [];

  return {
    actions: actions.map((action) => ({
      actionId: readString(asRecord(action).action_id) ?? "",
      value: readString(asRecord(action).value),
    })),
    channelId: readNestedId(record.channel) ?? "",
    threadTs: readString(asRecord(record.container).thread_ts),
    triggerId: readString(record.trigger_id),
    userId: readNestedId(record.user) ?? "",
  };
};

/**
 * Project a submitted modal onto the shape the view router needs.
 *
 * Slack nests each collected value under `state.values[block_id][action_id]`.
 * A block here carries a single element, so the action level is flattened away
 * at this boundary rather than in every handler.
 */
/**
 * One field's answer, whichever element collected it.
 *
 * Slack puts a text input's answer in `value`, a radio group's in
 * `selected_option`, and a checkbox set's in `selected_options`. Reading only
 * the first meant a form built from anything but text boxes came back empty —
 * with Submit working and `state.values` populated, so it read as the answer
 * being blank rather than as unread.
 */
const readAnswer = (element: Record<string, unknown>): string | undefined => {
  const many = element.selected_options;
  if (Array.isArray(many)) {
    const picked = many
      .map((option) => readString(asRecord(option).value))
      .filter((value): value is string => value !== undefined);
    return picked.length === 0 ? undefined : picked.join(", ");
  }
  const one = readString(asRecord(element.selected_option).value);
  return one ?? readString(element.value);
};

export const readViewSubmissionPayload = (
  body: unknown
): ViewSubmissionPayload => {
  const record = asRecord(body);
  const view = asRecord(record.view);
  const values = new Map<string, string>();

  for (const [blockId, block] of Object.entries(
    asRecord(asRecord(view.state).values)
  )) {
    for (const element of Object.values(asRecord(block))) {
      const answer = readAnswer(asRecord(element));
      if (answer !== undefined) {
        values.set(blockId, answer);
        break;
      }
    }
  }

  return {
    callbackId: readString(view.callback_id) ?? "",
    userId: readNestedId(record.user) ?? "",
    values,
  };
};

/**
 * Register every Bolt listener. `startTurn` and `dispatchInteraction` are
 * detached by the caller; nothing here awaits a turn.
 */
export const registerListeners = (input: {
  readonly app: App;
  readonly changeAssistantContext: (event: RawAssistantThreadStarted) => void;
  readonly dispatchInteraction: (payload: InteractionPayload) => Promise<void>;
  readonly dispatchView: (payload: ViewSubmissionPayload) => Promise<void>;
  readonly openAssistantThread: (event: RawAssistantThreadStarted) => void;
  readonly startTurn: (event: RawSlackMessage, addressed: boolean) => void;
}): void => {
  input.app.event("app_mention", ({ event }) => {
    input.startTurn(event as RawSlackMessage, true);
    return Promise.resolve();
  });

  // The one event that says a thread is an assistant pane. It arrives once,
  // before the first message, so the pane-only capabilities are unavailable
  // until it has been seen.
  input.app.event("assistant_thread_started", ({ event }) => {
    input.openAssistantThread(event as RawAssistantThreadStarted);
    return Promise.resolve();
  });

  // Same handler: the reader navigated to a different conversation behind the
  // pane. Ignoring it leaves the agent answering about the channel they left.
  input.app.event("assistant_thread_context_changed", ({ event }) => {
    input.changeAssistantContext(event as RawAssistantThreadStarted);
    return Promise.resolve();
  });

  input.app.message(({ message }) => {
    // A DM is unambiguous, so every message in one is a turn. In a channel the
    // bot answers a mention (which arrives as `app_mention` above) and, in a
    // thread it is already part of, a reply that names nobody — the turn path
    // decides which threads those are, since only it knows where the bot has
    // spoken. A top-level channel message is neither.
    const raw = message as RawSlackMessage;
    if (raw.channel_type === "im") {
      input.startTurn(raw, true);
      return Promise.resolve();
    }
    if (raw.thread_ts !== undefined) {
      input.startTurn(raw, false);
    }
    return Promise.resolve();
  });

  input.app.action(/.*/u, async ({ ack, body }) => {
    // Ack first: Slack expects a response within 3 seconds. `trigger_id` is
    // short-lived and is never persisted.
    await ack();
    await input.dispatchInteraction(readInteractionPayload(body));
  });

  input.app.view(/.*/u, async ({ ack, body }) => {
    // Acked before dispatch for the same reason, and unconditionally: an
    // unacked submission leaves the modal spinning in front of the person who
    // just answered, whatever the handler goes on to do.
    await ack();
    await input.dispatchView(readViewSubmissionPayload(body));
  });
};
