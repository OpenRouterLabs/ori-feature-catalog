import type { App } from "@slack/bolt";
import type { Context } from "effect";

import type { SlackReceiver } from "#src/client/receiver.ts";
import type { SlackLogger } from "#src/index.ts";
import type {
  InteractionPayload,
  ViewSubmissionPayload,
} from "#src/interactions/interactions.ts";
import type { SlackServices } from "#src/layers.ts";
import type { BoltIdentity } from "./bolt-lifecycle.ts";
import type { RawSlackMessage } from "./listeners.ts";

import { forkWith } from "#src/fork.ts";
import { makeBoltApp } from "./bolt-lifecycle.ts";
import { registerListeners } from "./listeners.ts";
import { makeSurfaceEventHandlers } from "./surface-events.ts";

type SurfaceTurns = {
  readonly startTurn: (event: RawSlackMessage, addressed: boolean) => void;
};

type Surface<Turns extends SurfaceTurns> = {
  readonly app: App;
  readonly receiver: SlackReceiver;
  readonly turns: Turns;
};

/**
 * Boots the Slack surface: the Bolt app and its receiver, the listeners bound
 * to them, and the assistant-pane handlers the listeners feed.
 *
 * `wireTurns` is a thunk rather than a plain `startTurn` because turn routing is
 * built between the Bolt app and the first listener, and the receiver's timers
 * start with the app. Taking the handler directly would move that construction
 * ahead of the app and change the boot order.
 */
export const makeSurface = async <Turns extends SurfaceTurns>(input: {
  readonly context: Context.Context<SlackServices>;
  readonly dispatchInteraction: (payload: InteractionPayload) => Promise<void>;
  readonly dispatchView: (payload: ViewSubmissionPayload) => Promise<void>;
  readonly identity?: BoltIdentity | undefined;
  readonly logger: SlackLogger;
  readonly signingSecret: string;
  readonly token: string;
  readonly wireTurns: () => Turns;
}): Promise<Surface<Turns>> => {
  const { app, receiver } = makeBoltApp({
    identity: input.identity,
    logger: input.logger,
    signingSecret: input.signingSecret,
    token: input.token,
  });

  const turns = input.wireTurns();

  registerListeners({
    app,
    ...makeSurfaceEventHandlers({
      context: input.context,
      runWith: forkWith(input.context),
    }),
    dispatchInteraction: input.dispatchInteraction,
    dispatchView: input.dispatchView,
    startTurn: turns.startTurn,
  });

  await app.start();
  input.logger.info("[slack] chat surface is live");

  return {
    app,
    receiver,
    turns,
  };
};
