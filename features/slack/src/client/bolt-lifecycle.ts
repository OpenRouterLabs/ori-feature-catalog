/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */

import type { AuthorizeResult } from "@slack/bolt";

import { App, LogLevel } from "@slack/bolt";
import { Effect, Exit, Option, Scope } from "effect";

import type { SlackLogger } from "../index.ts";
import type {
  InteractionPayload,
  ViewSubmissionPayload,
} from "../interactions/interactions.ts";
import type {
  RawAssistantThreadStarted,
  RawSlackMessage,
} from "./listeners.ts";

import { cancelAll, drain, resetRegistry } from "../thread/registry.ts";
import { registerListeners } from "./listeners.ts";
import { resolveSlackProxyAgent } from "./proxy-agent.ts";
import { SlackReceiver } from "./receiver.ts";

const SHUTDOWN_DRAIN_MS = 15_000;

const SHUTDOWN_SETTLE_MS = 5000;

export const makeStop =
  (deps: {
    readonly app: App;
    readonly logger: SlackLogger;
    readonly markStopping: () => void;
    readonly receiver: SlackReceiver;
    readonly scope: Scope.Closeable;
  }) =>
  async (): Promise<void> => {
    deps.markStopping();
    await deps.receiver.stop();

    if (!(await drain(SHUTDOWN_DRAIN_MS))) {
      const told = cancelAll();
      deps.logger.warn(
        `[slack] shutting down with ${told} turn(s) still running — stopping them`
      );
      if (!(await drain(SHUTDOWN_SETTLE_MS))) {
        deps.logger.warn("[slack] some turns did not settle before shutdown");
      }
    }

    await deps.app.stop();
    resetRegistry();
    await Effect.runPromise(Scope.close(deps.scope, Exit.void));
  };

interface BoltIdentity {
  readonly botId: string | undefined;
  readonly botUserId: string | undefined;
}

type BoltAuthorization =
  | { readonly authorize: () => Promise<AuthorizeResult> }
  | { readonly token: string };

const boltAuthorization = (input: {
  readonly identity?: BoltIdentity | undefined;
  readonly token: string;
}): BoltAuthorization =>
  Option.match(Option.fromNullishOr(input.identity?.botUserId), {
    onNone: (): BoltAuthorization => ({ token: input.token }),
    onSome: (botUserId): BoltAuthorization => ({
      authorize: () =>
        Promise.resolve({ botId: input.identity?.botId, botUserId }),
    }),
  });

export const makeBoltApp = (input: {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly identity?: BoltIdentity | undefined;
  readonly logger: SlackLogger;
  readonly signingSecret: string;
  readonly token: string;
}): { readonly app: App; readonly receiver: SlackReceiver } => {
  const receiver = new SlackReceiver({
    logger: input.logger,
    signingSecret: input.signingSecret,
  });
  const agent = resolveSlackProxyAgent(input.env ?? Bun.env);
  return {
    app: new App({
      agent,
      ...boltAuthorization(input),
      logLevel: LogLevel.WARN,
      receiver,
    }),
    receiver,
  };
};

export const goLive = async (input: {
  readonly app: App;
  readonly changeAssistantContext: (event: RawAssistantThreadStarted) => void;
  readonly dispatchInteraction: (payload: InteractionPayload) => Promise<void>;
  readonly dispatchView: (payload: ViewSubmissionPayload) => Promise<void>;
  readonly logger: SlackLogger;
  readonly openAssistantThread: (event: RawAssistantThreadStarted) => void;
  readonly startTurn: (event: RawSlackMessage, addressed: boolean) => void;
}): Promise<void> => {
  registerListeners({
    app: input.app,
    changeAssistantContext: input.changeAssistantContext,
    dispatchInteraction: input.dispatchInteraction,
    dispatchView: input.dispatchView,
    openAssistantThread: input.openAssistantThread,
    startTurn: input.startTurn,
  });
  await input.app.start();
  input.logger.info("[slack] chat surface is live");
};
