import type { App } from "@slack/bolt";

import { Schema } from "effect";

import type {
  InteractionPayload,
  ViewSubmissionPayload,
} from "#src/interactions/interactions.ts";

const OptionalString = Schema.optional(Schema.String);

export const RawAssistantThreadStartedSchema = Schema.Struct({
  assistant_thread: Schema.optional(
    Schema.Struct({
      channel_id: OptionalString,
      context: Schema.optional(
        Schema.Struct({
          channel_id: OptionalString,
          team_id: OptionalString,
        })
      ),
      thread_ts: OptionalString,
    })
  ),
});

export type RawAssistantThreadStarted =
  typeof RawAssistantThreadStartedSchema.Type;

export const RawSlackMessageSchema = Schema.Struct({
  bot_id: OptionalString,
  channel: OptionalString,
  channel_type: OptionalString,
  subtype: OptionalString,
  team: OptionalString,
  text: OptionalString,
  thread_ts: OptionalString,
  ts: OptionalString,
  user: OptionalString,
});

export type RawSlackMessage = typeof RawSlackMessageSchema.Type;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? { ...value } : {};

const readString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const readNestedId = (value: unknown): string | undefined =>
  readString(asRecord(value).id);

const readInteractionPayload = (body: unknown): InteractionPayload => {
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

  input.app.event("assistant_thread_started", ({ event }) => {
    input.openAssistantThread(event as RawAssistantThreadStarted);
    return Promise.resolve();
  });

  input.app.event("assistant_thread_context_changed", ({ event }) => {
    input.changeAssistantContext(event as RawAssistantThreadStarted);
    return Promise.resolve();
  });

  input.app.message(({ message }) => {
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
    await ack();
    await input.dispatchInteraction(readInteractionPayload(body));
  });

  input.app.view(/.*/u, async ({ ack, body }) => {
    await ack();
    await input.dispatchView(readViewSubmissionPayload(body));
  });
};
