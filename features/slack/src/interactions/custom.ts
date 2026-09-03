import { Context, Effect, Schema } from "effect";

import type { InteractionHandler, InteractionsShape } from "./interactions.ts";

import { featureState } from "#src/feature-state.ts";
import { Interactions } from "./interactions.ts";

const SlackButtonClickSchema = Schema.Struct({
  actionId: Schema.String,
  channelId: Schema.String,
  threadTs: Schema.UndefinedOr(Schema.String),
  userId: Schema.String,
  value: Schema.UndefinedOr(Schema.String),
});

export type SlackButtonClick = typeof SlackButtonClickSchema.Type;

export type SlackButtonHandler = (
  click: SlackButtonClick
) => Promise<void> | void;

export const RESERVED_ACTION_PREFIX = "ori_";

const registry = (): Map<string, SlackButtonHandler> => featureState().buttons;

const liveInteractions = (): InteractionsShape | undefined => {
  const { runtime } = featureState();
  return runtime === undefined
    ? undefined
    : Context.get(runtime.context, Interactions);
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
  liveInteractions()?.on(actionId, adapt(actionId, handler));
};

export const registeredButtonIds = (): readonly string[] => [
  ...registry().keys(),
];

export const registerCustomButtons = (
  next: InteractionsShape
): readonly string[] => {
  const ids = [...registry().entries()];
  for (const [actionId, handler] of ids) {
    next.on(actionId, adapt(actionId, handler));
  }
  return ids.map(([actionId]) => actionId);
};

export const resetCustomButtons = (): void => {
  registry().clear();
};
