import { Effect, Schema } from "effect";

import type { SlackApiError, SlackClientShape } from "#src/client/client.ts";
import type { SlackBlock } from "#src/helpers/block-kit/index.ts";

import { opaqueSchema } from "#src/schema-support.ts";

const ModalViewSchema = Schema.Struct({
  blocks: Schema.Array(opaqueSchema<SlackBlock>("ModalView.blocks")),
  callbackId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  closeLabel: Schema.optionalKey(Schema.String),
  submitLabel: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  title: Schema.String,
});

export type ModalView = typeof ModalViewSchema.Type;

export const openModal = (
  slack: SlackClientShape,
  input: { readonly triggerId: string; readonly view: ModalView }
): Effect.Effect<void, SlackApiError> =>
  slack.openView({
    trigger_id: input.triggerId,
    view: {
      blocks: [...input.view.blocks],
      close: {
        text: input.view.closeLabel ?? "Close",
        type: "plain_text",
      },
      title: {
        text: input.view.title,
        type: "plain_text",
      },
      type: "modal",
      ...(input.view.callbackId === undefined
        ? {}
        : { callback_id: input.view.callbackId }),
      ...(input.view.submitLabel === undefined
        ? {}
        : {
            submit: {
              text: input.view.submitLabel,
              type: "plain_text" as const,
            },
          }),
    },
  }).pipe(Effect.withSpan("Slack.modals.openModal"));
