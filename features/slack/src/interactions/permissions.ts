import type { PermissionOptionKind } from "ori";

import { Effect, Schema } from "effect";

import type { SlackBlock } from "#src/helpers/block-kit/index.ts";
import type {
  InteractionPayload,
  InteractionsShape,
} from "./interactions.ts";

import { actions, button, section } from "#src/helpers/block-kit/index.ts";
import { functionSchema, opaqueSchema } from "#src/schema-support.ts";

export const PERMISSION_ACTION_ID = "ori_permission_select";
export const ELICITATION_ACTION_ID = "ori_elicitation_select";

const FIELD_SEPARATOR = "|";

const PermissionRequestSchema = Schema.Struct({
  askedBy: Schema.String,
  correlationId: Schema.String,
  operation: Schema.String,
  options: Schema.Array(
    opaqueSchema<PermissionOptionKind>("PermissionRequest.options")
  ),
  sessionId: Schema.String,
});

type PermissionRequest = typeof PermissionRequestSchema.Type;

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

const DecodedChoiceSchema = Schema.Struct({
  askedBy: Schema.String,
  choice: Schema.String,
  correlationId: Schema.String,
  sessionId: Schema.String,
});

type DecodedChoice = typeof DecodedChoiceSchema.Type;

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

const ElicitationRequestSchema = Schema.Struct({
  askedBy: Schema.String,
  correlationId: Schema.String,
  message: Schema.String,
  sessionId: Schema.String,
});

type ElicitationRequest = typeof ElicitationRequestSchema.Type;

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

const RespondInteractionSchema = Schema.Struct({
  respond:
    functionSchema<
      (
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
      ) => Promise<void>
    >("RespondInteraction.respond"),
});

type RespondInteraction = typeof RespondInteractionSchema.Type;

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
