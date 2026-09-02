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
  globalThis.__oriSlackInteractions?.on(actionId, adapt(actionId, handler));
};

export const registeredButtonIds = (): readonly string[] => [
  ...registry().keys(),
];

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

export const resetCustomButtons = (): void => {
  globalThis.__oriSlackButtons = undefined;
  globalThis.__oriSlackInteractions = undefined;
};
