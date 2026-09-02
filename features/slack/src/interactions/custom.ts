import { Effect } from "effect";

import type { InteractionHandler, InteractionsShape } from "./interactions.ts";

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

const buttons = new Map<string, SlackButtonHandler>();

let interactions: InteractionsShape | undefined;

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
  buttons.set(actionId, handler);
  interactions?.on(actionId, adapt(actionId, handler));
};

export const registeredButtonIds = (): readonly string[] => [...buttons.keys()];

export const registerCustomButtons = (
  next: InteractionsShape
): readonly string[] => {
  interactions = next;
  const ids = [...buttons.entries()];
  for (const [actionId, handler] of ids) {
    next.on(actionId, adapt(actionId, handler));
  }
  return ids.map(([actionId]) => actionId);
};

export const resetCustomButtons = (): void => {
  buttons.clear();
  interactions = undefined;
};
