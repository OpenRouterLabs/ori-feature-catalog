/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * bolt-lifecycle.ts — the Bolt app, its receiver, and how both go up and down.
 *
 * Split from `index.ts` so that file is about COMPOSING the service graph while
 * this one is about the Slack connection's lifecycle. The two change for
 * different reasons: a new capability touches the graph, a new event touches
 * the listeners.
 */

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

import { cancelAll, drain, resetRegistry } from "../thread/index.ts";
import { registerListeners } from "./listeners.ts";
import { resolveSlackProxyAgent } from "./proxy-agent.ts";
import { SlackReceiver } from "./receiver.ts";

/** How long shutdown waits for live turns to finish on their own. */
const SHUTDOWN_DRAIN_MS = 15_000;

/**
 * How long they then get to settle their messages once told to stop.
 *
 * Short: a turn that has been told to stop has at most a final post left, not
 * more work. It only has to beat the process going away.
 */
const SHUTDOWN_SETTLE_MS = 5000;

/**
 * Shut down without stranding work.
 *
 * The receiver is stopped FIRST. Otherwise events arriving during the drain are
 * admitted, acked 200, and then abandoned when the process goes away — the
 * sender sees "Queued" and then silence, with Slack believing the event was
 * delivered. A stopped receiver answers 503 instead, and Slack redelivers to
 * the restarted instance.
 *
 * Draining then happens before the Bolt app stops, because stopping the app
 * first pulls the client out from under turns that are still streaming.
 */
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
      // Whatever is left is not going to finish in time, and abandoning it
      // strands the message it owns. Tell it to stop so it can say so.
      const told = cancelAll();
      deps.logger.warn(
        `[slack] shutting down with ${told} turn(s) still running — stopping them`
      );
      if (!(await drain(SHUTDOWN_SETTLE_MS))) {
        deps.logger.warn("[slack] some turns did not settle before shutdown");
      }
    }

    await deps.app.stop();
    // Module-global, so a stop/start cycle would otherwise leave a stopped
    // run's threads marked busy and the next turn would queue forever.
    resetRegistry();
    // Releases anything an extension acquired while building the graph.
    await Effect.runPromise(Scope.close(deps.scope, Exit.void));
  };

/**
 * Bolt driven by our own receiver rather than one of its built-in servers: the
 * daemon already owns the HTTP listener, so this plugs into it.
 */
/** Who Slack says we are, resolved on our own proxied client. */
interface BoltIdentity {
  readonly botId: string | undefined;
  readonly botUserId: string | undefined;
}

/*
 * `authorize`, not `token`: given a token Bolt calls `auth.test({ token })`
 * itself, and a per-call token rides the request BODY too (WebClient.js:199),
 * where the vault cannot substitute it. A resolved identity removes the call.
 */
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
  /** Absent, or without a user id, means identity resolution failed. */
  readonly identity?: BoltIdentity | undefined;
  readonly logger: SlackLogger;
  readonly signingSecret: string;
  readonly token: string;
}): { readonly app: App; readonly receiver: SlackReceiver } => {
  const receiver = new SlackReceiver({
    logger: input.logger,
    signingSecret: input.signingSecret,
  });
  /*
   * Bolt builds its OWN WebClient and axios instance, and the authorization
   * path runs on them, not on ours: with `tokenVerificationEnabled` defaulting
   * to true the constructor fires `client.auth.test` and caches the result as
   * the authorize function. Unproxied, that answers `invalid_auth` against the
   * container's placeholder token and every incoming event is then refused
   * with "No listeners will be called". `agent` is the one option that reaches
   * both — App routes it into `clientOptions.agent` and into axios's
   * http/httpsAgent — so it must be set here as well as on our own client.
   */
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

/** Register the listeners and open the surface for traffic. */
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
