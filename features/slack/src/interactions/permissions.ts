import type { PermissionOptionKind } from "ori";

import { Effect } from "effect";

import type { SlackBlock } from "#src/helpers/block-kit/blocks.ts";
import type {
  InteractionPayload,
  InteractionsShape,
} from "./interactions.ts";

import { actions, button, section } from "#src/helpers/block-kit/blocks.ts";

export const PERMISSION_ACTION_ID = "ori_permission_select";
export const ELICITATION_ACTION_ID = "ori_elicitation_select";

const FIELD_SEPARATOR = "|";

interface PermissionRequest {
  readonly askedBy: string;
  readonly correlationId: string;
  readonly operation: string;
  readonly options: readonly PermissionOptionKind[];
  readonly sessionId: string;
}

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

const clickedByRequester = (
  decoded: DecodedChoice,
  clickedBy: string
): boolean => decoded.askedBy === clickedBy;

const isPermissionOptionKind = (value: string): value is PermissionOptionKind =>
  value in OPTION_LABELS;

export const permissionBlocks = (
  request: PermissionRequest
): readonly SlackBlock[] => [
  section(`**Permission needed**\n${request.operation}`),
  actions(
    request.options.map((option, index) =>
      button({
        actionId: `${PERMISSION_ACTION_ID}|${index}`,
        label: OPTION_LABELS[option],
        value: encode(request, option),
      })
    )
  ),
];

export const permissionResolvedBlocks = (
  request: Pick<PermissionRequest, "operation">,
  outcome: string
): readonly SlackBlock[] => [
  section(`**Permission** — ${request.operation}\n_${outcome}_`),
];

interface ElicitationRequest {
  readonly askedBy: string;
  readonly correlationId: string;
  readonly message: string;
  readonly sessionId: string;
}

export const elicitationBlocks = (
  request: ElicitationRequest
): readonly SlackBlock[] => [
  section(`**Input requested**\n${request.message}`),
  actions(
    ["decline", "cancel"].map((action, index) =>
      button({
        actionId: `${ELICITATION_ACTION_ID}|${index}`,
        label: action === "decline" ? "Decline" : "Cancel",
        value: encode(request, action),
      })
    )
  ),
];

interface RespondInteraction {
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

export const registerPermissionHandlers = (
  interactions: InteractionsShape,
  bridge: RespondInteraction
): void => {
  interactions.onPrefix(
    PERMISSION_ACTION_ID,
    Effect.fn("Slack.interactions.respondPermission")(function* (
      payload: InteractionPayload
    ) {
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

  interactions.onPrefix(
    ELICITATION_ACTION_ID,
    Effect.fn("Slack.interactions.respondElicitation")(function* (
      payload: InteractionPayload
    ) {
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

const CANCEL_ACTION_ID = "ori_cancel_turn";

export const registerCancelHandler = (
  interactions: InteractionsShape,
  cancel: (turnId: string) => boolean
): void => {
  interactions.on(CANCEL_ACTION_ID, (payload) =>
    Effect.sync(() => {
      const [turnId, askedBy] = (payload.actions.at(0)?.value ?? "").split(
        FIELD_SEPARATOR
      );
      if (turnId !== undefined && askedBy === payload.userId) {
        cancel(turnId);
      }
    }).pipe(Effect.withSpan("Slack.interactions.cancelTurn"))
  );
};
