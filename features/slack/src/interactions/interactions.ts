import { Context, Effect } from "effect";

interface InteractionAction {
  readonly actionId: string;
  readonly value: string | undefined;
}

export interface InteractionPayload {
  readonly actions: readonly InteractionAction[];
  readonly channelId: string;
  readonly threadTs: string | undefined;
  readonly triggerId: string | undefined;
  readonly userId: string;
}

export interface ViewSubmissionPayload {
  readonly callbackId: string;
  readonly userId: string;
  readonly values: ReadonlyMap<string, string>;
}

export type InteractionHandler = (
  payload: InteractionPayload
) => Effect.Effect<void>;

type ViewHandler = (
  payload: ViewSubmissionPayload
) => Effect.Effect<void>;

export interface InteractionsShape {
  readonly dispatch: (payload: InteractionPayload) => Effect.Effect<void>;
  readonly dispatchView: (
    payload: ViewSubmissionPayload
  ) => Effect.Effect<void>;
  readonly on: (actionId: string, handler: InteractionHandler) => void;
  readonly onPrefix: (
    actionPrefix: string,
    handler: InteractionHandler
  ) => void;
  readonly onView: (callbackPrefix: string, handler: ViewHandler) => void;
}

export class Interactions extends Context.Service<
  Interactions,
  InteractionsShape
>()("ori/slack/Interactions") {}

export const makeInteractions = (): InteractionsShape => {
  const handlers = new Map<string, InteractionHandler>();
  const prefixHandlers = new Map<string, InteractionHandler>();
  const viewHandlers = new Map<string, ViewHandler>();

  const handlerFor = (actionId: string): InteractionHandler | undefined =>
    handlers.get(actionId) ??
    [...prefixHandlers].find(([prefix]) => actionId.startsWith(prefix))?.[1];

  return {
    dispatch: (payload) =>
      Effect.forEach(
        payload.actions,
        (action) => {
          const handler = handlerFor(action.actionId);
          return handler === undefined
            ?
              Effect.logWarning(
                `[slack] no handler for interaction: ${action.actionId}`
              )
            : handler(payload).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError(
                    `[slack] interaction handler failed: ${action.actionId}`,
                    cause
                  )
                )
              );
        },
        { discard: true }
      ).pipe(Effect.withSpan("Slack.interactions.dispatch")),

    dispatchView: (payload) => {
      const match = [...viewHandlers].find(([prefix]) =>
        payload.callbackId.startsWith(prefix)
      );
      return (
        match === undefined
          ? Effect.void
          : match[1](payload).pipe(
              Effect.catchCause((cause) =>
                Effect.logError(
                  `[slack] view handler failed: ${payload.callbackId}`,
                  cause
                )
              )
            )
      ).pipe(Effect.withSpan("Slack.interactions.dispatchView"));
    },

    on: (actionId, handler) => {
      handlers.set(actionId, handler);
    },

    onPrefix: (actionPrefix, handler) => {
      prefixHandlers.set(actionPrefix, handler);
    },

    onView: (callbackPrefix, handler) => {
      viewHandlers.set(callbackPrefix, handler);
    },
  };
};
