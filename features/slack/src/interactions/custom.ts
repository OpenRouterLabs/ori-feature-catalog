import { Effect } from "effect";

import type { InteractionHandler, InteractionsShape } from "./interactions.ts";

import { globalSlot } from "#src/global-slot.ts";

export interface SlackButtonClick {
  readonly actionId: string;
  readonly channelId: string;
  readonly threadTs: string | undefined;
  readonly userId: string;
  readonly value: string | undefined;
}

export type SlackButtonHandler = (
  click: SlackButtonClick
) => Promise<void> | void;

export const RESERVED_ACTION_PREFIX = "ori_";

const buttons = globalSlot<Map<string, SlackButtonHandler>>(
  "ori.slack.buttons"
);

const interactions = globalSlot<InteractionsShape>("ori.slack.interactions");

const registry = (): Map<string, SlackButtonHandler> => {
  const held = buttons.read();
  if (held !== undefined) {
    return held;
  }
  const created = new Map<string, SlackButtonHandler>();
  buttons.install(created);
  return created;
};

const adapt =
  (actionId: string, handler: SlackButtonHandler): InteractionHandler =>
  (payload) =>
    Effect.gen(function* () {
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
  interactions.read()?.on(actionId, adapt(actionId, handler));
};

export const registeredButtonIds = (): readonly string[] => [
  ...registry().keys(),
];

export const registerCustomButtons = (
  next: InteractionsShape
): readonly string[] => {
  interactions.install(next);
  const ids = [...registry().entries()];
  for (const [actionId, handler] of ids) {
    next.on(actionId, adapt(actionId, handler));
  }
  return ids.map(([actionId]) => actionId);
};

export const resetCustomButtons = (): void => {
  buttons.clear();
  interactions.clear();
};
