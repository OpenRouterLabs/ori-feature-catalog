/**
 * interactions.ts — buttons and interaction events.
 *
 * Registered as a service so a downstream feature can wrap it (add an action,
 * change what a button does) without replacing the Slack surface.
 *
 * Interactive payloads carry short-lived provider capabilities — `trigger_id`,
 * `response_url`. They are valid for seconds to minutes and only inside the
 * request that delivered them, so they must never reach dispatch input, model
 * context, logs, or durable state.
 */

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

/**
 * A submitted modal.
 *
 * `values` is keyed by `block_id` and holds the one value that block collected.
 * Slack nests it a further level under `action_id`, which nothing here needs:
 * a block carries a single element, so flattening it at the boundary keeps the
 * nested provider shape out of every handler.
 */
export interface ViewSubmissionPayload {
  readonly callbackId: string;
  readonly userId: string;
  readonly values: ReadonlyMap<string, string>;
}

type InteractionHandler = (
  payload: InteractionPayload
) => Effect.Effect<void>;

type ViewHandler = (
  payload: ViewSubmissionPayload
) => Effect.Effect<void>;

export interface InteractionsShape {
  /** Route one interactive payload. Unknown action ids are ignored. */
  readonly dispatch: (payload: InteractionPayload) => Effect.Effect<void>;
  /** Route one submitted modal. Unknown callback prefixes are ignored. */
  readonly dispatchView: (
    payload: ViewSubmissionPayload
  ) => Effect.Effect<void>;
  /** Register a handler for an action id. Last registration wins. */
  readonly on: (actionId: string, handler: InteractionHandler) => void;
  /**
   * Register a handler for a modal callback id. Matched by PREFIX, because a
   * callback id has to carry the ask it answers — a `view_submission` payload
   * carries no button value, so the id is the only place to put it.
   */
  readonly onView: (callbackPrefix: string, handler: ViewHandler) => void;
}

export class Interactions extends Context.Service<
  Interactions,
  InteractionsShape
>()("ori/slack/Interactions") {}

export const makeInteractions = (): InteractionsShape => {
  const handlers = new Map<string, InteractionHandler>();
  const viewHandlers = new Map<string, ViewHandler>();

  return {
    dispatch: (payload) =>
      Effect.forEach(
        payload.actions,
        (action) => {
          const handler = handlers.get(action.actionId);
          // One failing action must not abandon the others — but it must not
          // vanish either. These handlers are how an approval reaches the
          // waiting turn, so a swallowed failure looks like a button that did
          // nothing and a run that hangs until its deadline, with no record of
          // why.
          return handler === undefined
            ? Effect.void
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
      // Logged rather than swallowed, for the reason above: this is how a
      // typed answer reaches the waiting turn, and a lost one looks like a
      // modal that did nothing and a run that hangs until its deadline.
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

    onView: (callbackPrefix, handler) => {
      viewHandlers.set(callbackPrefix, handler);
    },
  };
};
