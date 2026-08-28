/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * bolt-lifecycle.ts — the Bolt app, its receiver, and how both go up and down.
 *
 * Split from `index.ts` so that file is about COMPOSING the service graph while
 * this one is about the Slack connection's lifecycle. The two change for
 * different reasons: a new capability touches the graph, a new event touches
 * the listeners.
 */

import { App, LogLevel } from "@slack/bolt";
import { Effect, Exit, Predicate, Scope } from "effect";

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
export const makeBoltApp = (input: {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Resolved on OUR proxied client. Absent means identity resolution failed. */
  readonly identity?:
    | {
        readonly botId: string | undefined;
        readonly botUserId: string | undefined;
      }
    | undefined;
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
  /*
   * `authorize`, not `token`, and this is the whole point.
   *
   * Given a token Bolt authenticates for itself: with `tokenVerificationEnabled`
   * defaulting to true it calls `auth.test({ token })` on its own client and
   * caches the result as the authorize function. A PER-CALL token does not only
   * set the header — `WebClient.apiCall` spreads its options into the request
   * BODY, so `body.token` carries it too (`WebClient.js:199-201`). On a
   * vault-mode intern the sidecar substitutes the header and the body still
   * carries `__slack_bot_token__`, Slack reads that, and every incoming event is
   * refused with "No listeners will be called". Proxying the call cannot fix it,
   * because the placeholder is inside the request.
   *
   * Handing Bolt an identity we already resolved on our own client removes the
   * call, so there is nothing left to substitute. Falling back to `token` when
   * identity resolution failed keeps the previous behaviour rather than booting
   * a surface that cannot authorize at all.
   */
  const identity = input.identity;
  const authorize =
    Predicate.isNotUndefined(identity) &&
    Predicate.isNotUndefined(identity.botUserId)
      ? {
          authorize: () =>
            Promise.resolve(
              Predicate.isUndefined(identity.botId)
                ? { botUserId: identity.botUserId }
                : { botId: identity.botId, botUserId: identity.botUserId }
            ),
        }
      : { token: input.token };
  return {
    app: new App({
      ...(Predicate.isNotUndefined(agent) ? { agent } : {}),
      ...authorize,
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
