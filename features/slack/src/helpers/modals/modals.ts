/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * modals.ts — opening a modal.
 *
 * The constraint worth knowing: `trigger_id` comes from a user interaction and
 * expires in seconds. A long turn cannot open a modal from the event that
 * started it — post a button first, then use that interaction's fresh trigger.
 */

import type { Effect } from "effect";

import type { SlackApiError, SlackClientShape } from "../../client/client.ts";
import type { SlackBlock } from "../block-kit/blocks.ts";

export interface ModalView {
  readonly title: string;
  readonly blocks: readonly SlackBlock[];
  readonly closeLabel?: string;
  /**
   * Identifies the view on submission. A `view_submission` payload carries no
   * button value, so this is how a handler knows which ask it answers.
   */
  readonly callbackId?: string | undefined;
  /** Present only on a modal that collects something — Slack shows no submit
   * button without it, which is what makes a modal read-only. */
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
  });
