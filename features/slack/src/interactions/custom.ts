/**
 * custom.ts — buttons a sibling feature owns.
 *
 * `interactions.on` already routes any action id, but nothing outside this
 * feature could reach it. The service lives inside the Effect graph, and the
 * only public surface is `use("slack")` — which posts messages and hands back
 * a client. So a feature could build a Block Kit button and post it, and the
 * click went nowhere: `dispatch` looks the id up, finds no handler, returns.
 * The button rendered, and did nothing. This is the registration path that
 * closes that gap.
 *
 * Deliberately Effect-free and SDK-free at the boundary, matching
 * `exports.ts`: registering a button should not cost the caller a dependency
 * on effect or @slack/web-api.
 *
 * Registrations live on `globalThis` for the reason `extend.ts` gives — the
 * eager `feature.ts` and the dynamically imported runtime resolve as two
 * module graphs, so a module-local Map would be written by one copy and read
 * by another.
 */

import { Effect } from "effect";

import type { InteractionHandler, InteractionsShape } from "./interactions.ts";

/**
 * What a handler is told about a click.
 *
 * Note what is NOT here: `trigger_id` and `response_url`. Those are the
 * short-lived provider capabilities `interactions.ts` warns about — valid for
 * seconds, only inside the request that carried them, and never safe in model
 * context, logs or durable state. A registered handler runs after the ack, so
 * it could not use them anyway; leaving them out means a consumer cannot
 * capture one by accident. It also means a custom button cannot open a modal
 * — that needs a trigger the surface itself must spend.
 */
export interface SlackButtonClick {
  /** The action id that was clicked — the one this handler registered. */
  readonly actionId: string;
  readonly channelId: string;
  /** The thread the button is in, when it was posted into one. */
  readonly threadTs: string | undefined;
  /** Who clicked. Everyone who can see the thread can, so check it. */
  readonly userId: string;
  /** The button's `value`, if it carried one. */
  readonly value: string | undefined;
}

export type SlackButtonHandler = (
  click: SlackButtonClick
) => Promise<void> | void;

/**
 * Every built-in action id starts with this. Reserving the prefix rather than
 * a fixed list is what keeps the guard correct when a new built-in lands:
 * `on()` is last-registration-wins, so a custom button that claimed
 * `ori_cancel_turn` would silently take over stopping a run.
 */
export const RESERVED_ACTION_PREFIX = "ori_";

declare global {
  // oxlint-disable-next-line no-var -- required for global augmentation
  var __oriSlackButtons: Map<string, SlackButtonHandler> | undefined;
  // oxlint-disable-next-line no-var -- required for global augmentation
  var __oriSlackInteractions: InteractionsShape | undefined;
}

const registry = (): Map<string, SlackButtonHandler> => {
  globalThis.__oriSlackButtons ??= new Map<string, SlackButtonHandler>();
  return globalThis.__oriSlackButtons;
};

/**
 * Adapt a plain handler to the router.
 *
 * A rejected promise becomes a defect rather than a failure, because
 * `dispatch` types handlers as infallible and logs the cause of anything that
 * dies. That is the behaviour we want: a handler that throws must leave a
 * record, not read as a button that did nothing.
 */
const adapt =
  (actionId: string, handler: SlackButtonHandler): InteractionHandler =>
  (payload) =>
    Effect.gen(function* () {
      // The payload can carry several actions; take the value off the one
      // that matches, not off the first in the list.
      const action = payload.actions.find((a) => a.actionId === actionId);
      yield* Effect.tryPromise(async () => {
        await handler({
          actionId,
          channelId: payload.channelId,
          threadTs: payload.threadTs,
          userId: payload.userId,
          value: action?.value,
        });
      }).pipe(Effect.orDie);
    });

/**
 * Register a button handler by action id. Last registration wins, matching
 * `interactions.on`.
 *
 * Safe to call before the surface boots — the usual case, since a feature
 * registers at module scope — and after, in which case it wires immediately
 * rather than being silently dropped.
 *
 * Throws on a reserved or empty id. A throw at registration is a boot-time
 * failure the author sees; the alternative is a button that quietly shadows a
 * built-in and is found much later.
 */
export const onButton = (
  actionId: string,
  handler: SlackButtonHandler
): void => {
  if (actionId.trim() === "") {
    throw new Error("[slack] a custom button needs a non-empty action id");
  }
  if (actionId.startsWith(RESERVED_ACTION_PREFIX)) {
    throw new Error(
      `[slack] action id "${actionId}" is reserved: "${RESERVED_ACTION_PREFIX}" belongs to the surface's own buttons`
    );
  }
  registry().set(actionId, handler);
  // Already running: wire it now. Registering into a live surface is worth
  // supporting because a schedule or a route may add a button long after boot.
  globalThis.__oriSlackInteractions?.on(actionId, adapt(actionId, handler));
};

/** The ids registered so far. For tests and for the boot log. */
export const registeredButtonIds = (): readonly string[] => [
  ...registry().keys(),
];

/**
 * Fold everything registered so far into the router, and remember it so a
 * later `onButton` can wire itself. Called once, as the surface starts.
 */
export const registerCustomButtons = (
  interactions: InteractionsShape
): readonly string[] => {
  globalThis.__oriSlackInteractions = interactions;
  const ids = [...registry().entries()];
  for (const [actionId, handler] of ids) {
    interactions.on(actionId, adapt(actionId, handler));
  }
  return ids.map(([actionId]) => actionId);
};

/** Test seam. Drops every registration and forgets the live router. */
export const resetCustomButtons = (): void => {
  globalThis.__oriSlackButtons = undefined;
  globalThis.__oriSlackInteractions = undefined;
};
