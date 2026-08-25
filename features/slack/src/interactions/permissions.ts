/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * permissions.ts — the approval round-trip.
 *
 * This is why the interactions layer exists. When the agent wants to run
 * something gated it emits `permission.requested` and then WAITS. Without a
 * surface that renders the options and answers, the turn hangs forever and the
 * thread shows progress that will never finish.
 *
 * The loop:
 *
 *   permission.requested  -> post buttons in the thread
 *   button click          -> bridge.respondInteraction(...)
 *   permission.resolved   -> rewrite the message to the outcome
 *
 * The correlation id travels in the button's `value`, not in its `action_id`.
 * Action ids are registered up front and a correlation id is only known at
 * request time, so encoding it in the id would mean registering a handler per
 * request and leaking them. `value` is what Slack provides for exactly this.
 */

import type { PermissionOptionKind } from "ori";

import { Effect } from "effect";

import type { SlackBlock } from "../helpers/block-kit/blocks.ts";
import type { InteractionsShape } from "./interactions.ts";

import { actions, button, section } from "../helpers/block-kit/blocks.ts";

export const PERMISSION_ACTION_ID = "ori_permission_select";
export const ELICITATION_ACTION_ID = "ori_elicitation_select";

/** Separator that cannot appear in a correlation id, option kind, or session id. */
const FIELD_SEPARATOR = "|";

export interface PermissionRequest {
  /** The Slack user whose turn this is — the only one who may answer it. */
  readonly askedBy: string;
  readonly correlationId: string;
  readonly operation: string;
  readonly options: readonly PermissionOptionKind[];
  readonly sessionId: string;
}

/** Human labels. The raw kinds are protocol tokens, not UI copy. */
const OPTION_LABELS: Readonly<Record<PermissionOptionKind, string>> = {
  allow_always: "Always allow",
  allow_once: "Allow once",
  reject_always: "Always deny",
  reject_once: "Deny",
};

const encode = (
  request: Pick<PermissionRequest, "askedBy" | "correlationId" | "sessionId">,
  choice: string
): string =>
  [request.correlationId, request.sessionId, choice, request.askedBy].join(
    FIELD_SEPARATOR
  );

interface DecodedChoice {
  readonly askedBy: string;
  readonly choice: string;
  readonly correlationId: string;
  readonly sessionId: string;
}

const decode = (value: string | undefined): DecodedChoice | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const [correlationId, sessionId, choice, askedBy] =
    value.split(FIELD_SEPARATOR);
  return correlationId === undefined ||
    sessionId === undefined ||
    choice === undefined ||
    askedBy === undefined
    ? undefined
    : {
        askedBy,
        choice,
        correlationId,
        sessionId,
      };
};

/**
 * Buttons live in a channel, so everyone who can see the thread can click
 * them. Only the person whose turn raised the request may answer it —
 * otherwise any channel member can approve a command on someone else's
 * behalf, which defeats the point of asking.
 */
const clickedByRequester = (
  decoded: DecodedChoice,
  clickedBy: string
): boolean => decoded.askedBy === clickedBy;

const isPermissionOptionKind = (value: string): value is PermissionOptionKind =>
  value in OPTION_LABELS;

/** Block Kit for one pending approval. */
export const permissionBlocks = (
  request: PermissionRequest
): readonly SlackBlock[] => [
  section(`*Permission needed*\n${request.operation}`),
  actions(
    request.options.map((option) =>
      button({
        actionId: PERMISSION_ACTION_ID,
        label: OPTION_LABELS[option],
        value: encode(request, option),
      })
    )
  ),
];

/** What the message becomes once answered — buttons removed. */
export const permissionResolvedBlocks = (
  request: Pick<PermissionRequest, "operation">,
  outcome: string
): readonly SlackBlock[] => [
  section(`*Permission* — ${request.operation}\n_${outcome}_`),
];

export interface ElicitationRequest {
  readonly askedBy: string;
  readonly correlationId: string;
  readonly message: string;
  readonly sessionId: string;
}

/**
 * Elicitation asks for structured input. Slack cannot collect arbitrary fields
 * from a message, so this surfaces the ask and offers the two answers that
 * unblock the turn without inventing content. Accepting with real field values
 * needs a modal, which is a separate piece of work.
 */
export const elicitationBlocks = (
  request: ElicitationRequest
): readonly SlackBlock[] => [
  section(`*Input requested*\n${request.message}`),
  actions(
    ["decline", "cancel"].map((action) =>
      button({
        actionId: ELICITATION_ACTION_ID,
        label: action === "decline" ? "Decline" : "Cancel",
        value: encode(request, action),
      })
    )
  ),
];

export interface RespondInteraction {
  readonly respond: (
    input:
      | {
          readonly correlationId: string;
          readonly kind: "permission";
          readonly response:
            | { readonly outcome: "cancelled" }
            | {
                readonly optionKind: PermissionOptionKind;
                readonly outcome: "selected";
              };
          readonly sessionId: string;
        }
      | {
          readonly correlationId: string;
          readonly kind: "elicitation";
          readonly response:
            | { readonly action: "cancel" }
            | { readonly action: "decline" };
          readonly sessionId: string;
        }
  ) => Promise<void>;
}

/**
 * Wire the two action ids to the bridge. Registered once at start, not per
 * request — the correlation id arrives in the click, so one handler serves
 * every pending approval.
 */
export const registerPermissionHandlers = (
  interactions: InteractionsShape,
  bridge: RespondInteraction
): void => {
  interactions.on(PERMISSION_ACTION_ID, (payload) =>
    Effect.gen(function* () {
      const decoded = decode(payload.actions.at(0)?.value);
      if (
        decoded === undefined ||
        !clickedByRequester(decoded, payload.userId)
      ) {
        return;
      }
      yield* Effect.promise(() =>
        bridge.respond({
          correlationId: decoded.correlationId,
          kind: "permission",
          response: isPermissionOptionKind(decoded.choice)
            ? {
                optionKind: decoded.choice,
                outcome: "selected",
              }
            : { outcome: "cancelled" },
          sessionId: decoded.sessionId,
        })
      );
    })
  );

  interactions.on(ELICITATION_ACTION_ID, (payload) =>
    Effect.gen(function* () {
      const decoded = decode(payload.actions.at(0)?.value);
      if (
        decoded === undefined ||
        !clickedByRequester(decoded, payload.userId)
      ) {
        return;
      }
      yield* Effect.promise(() =>
        bridge.respond({
          correlationId: decoded.correlationId,
          kind: "elicitation",
          response:
            decoded.choice === "decline"
              ? { action: "decline" }
              : { action: "cancel" },
          sessionId: decoded.sessionId,
        })
      );
    })
  );
};

export const CANCEL_ACTION_ID = "ori_cancel_turn";

/**
 * Wire the Cancel button to the live-turn registry. Registered once at start;
 * the turn id arrives in the click.
 */
export const registerCancelHandler = (
  interactions: InteractionsShape,
  cancel: (turnId: string) => boolean
): void => {
  interactions.on(CANCEL_ACTION_ID, (payload) =>
    Effect.sync(() => {
      const [turnId, askedBy] = (payload.actions.at(0)?.value ?? "").split(
        FIELD_SEPARATOR
      );
      // Same rule as approvals: only the person who started the run stops it.
      if (turnId !== undefined && askedBy === payload.userId) {
        // A false return means the turn already finished — the button simply
        // outlived its run, which is not an error worth surfacing.
        cancel(turnId);
      }
    })
  );
};
