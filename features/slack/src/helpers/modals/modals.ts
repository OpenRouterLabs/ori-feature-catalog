/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */

import { Effect } from "effect";

import type { SlackApiError, SlackClientShape } from "../../client/index.ts";
import type { SlackBlock } from "../block-kit/blocks.ts";

export interface ModalView {
  readonly title: string;
  readonly blocks: readonly SlackBlock[];
  readonly closeLabel?: string;
  readonly callbackId?: string | undefined;
  readonly submitLabel?: string | undefined;
}

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
