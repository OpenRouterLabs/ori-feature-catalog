import type { AuthorizeResult } from "@slack/bolt";

import { App, LogLevel } from "@slack/bolt";
import { Effect, Exit, Option, Schema, Scope } from "effect";

import type { SlackLogger } from "#src/index.ts";

import { cancelAll, drain, resetRegistry } from "#src/thread/registry.ts";
import { resolveSlackProxyAgent } from "#src/client/proxy-agent.ts";
import { SlackReceiver } from "#src/client/receiver.ts";

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

const BoltIdentitySchema = Schema.Struct({
  botId: Schema.UndefinedOr(Schema.String),
  botUserId: Schema.UndefinedOr(Schema.String),
});

export type BoltIdentity = typeof BoltIdentitySchema.Type;

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
