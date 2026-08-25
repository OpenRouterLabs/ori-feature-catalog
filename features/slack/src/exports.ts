/**
 * exports.ts — the `use("slack")` provider surface.
 *
 * Any feature can post to Slack without a token or a `@slack/web-api`
 * dependency: this feature owns both. The shape is fixed by the generated ori
 * SDK (`SlackFeatureApiExports`), which declares `FeatureApis.slack` for every
 * workspace whether or not this feature implements it — so dropping the
 * implementation does not produce a type error at the call site, it produces a
 * runtime no-op. That silence is why this is worth keeping in step.
 *
 * It returns a result union rather than throwing: a caller posting a courtesy
 * notification should not have its own work fail because Slack was rate
 * limited.
 *
 * Deliberately independent of the chat surface's lifecycle. A feature may post
 * from a schedule or an API route while no chat surface is running, so this
 * builds its own client from the environment rather than reaching for the
 * runtime handle.
 */

import type { Block, KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";

import type { SlackClientShape } from "./client/client.ts";

import { makeSlackClientFromToken } from "./client/client-live.ts";
import { readBotToken } from "./config.ts";
import { capBlocks, withinSlackLimit } from "./helpers/block-kit/blocks.ts";

export interface SlackPostMessageInput {
  readonly channel: string;
  readonly text: string;
  readonly threadTs?: string;
  readonly blocks?: readonly (Block | KnownBlock)[];
  readonly unfurlLinks?: boolean;
  readonly unfurlMedia?: boolean;
}

export type SlackPostMessageResult =
  | { readonly ok: true; readonly channel: string; readonly ts?: string }
  | { readonly ok: false; readonly error: string };

let client: SlackClientShape | undefined;

/**
 * The one client, in priority order: the running surface's, then our own.
 *
 * The Slack SDK's rate-limit queue lives on the client instance, so every
 * extra instance is another queue that cannot see the others — each polite on
 * its own while Slack sees the sum. Building our own unconditionally meant a
 * process running the chat surface held two: the surface's, and this one.
 *
 * Read off `globalThis` for the reason `feature.ts` puts it there: the eager
 * module and the dynamic `import()` resolve as two module graphs, so a
 * module-local binding exists twice and a graph-crossing lookup is the only
 * one that finds the same object from both.
 *
 * Falling back rather than requiring it, because this api is reachable with
 * no surface running at all — a schedule or an API route may post from a
 * process that never booted Slack. That independence is the point of the
 * export and is not traded away for the shared queue.
 */
const resolveClient = (): SlackClientShape | undefined => {
  const running = globalThis.__oriSlackRuntime?.slack;
  if (running !== undefined) {
    return running;
  }
  if (client !== undefined) {
    return client;
  }
  // Tolerant on purpose: this api is reachable without the surface running,
  // so an unconfigured workspace gets "not available", not a thrown boot error.
  const token = readBotToken();
  if (token === undefined) {
    return undefined;
  }
  client = makeSlackClientFromToken(token);
  return client;
};

/**
 * The Slack client itself, for callers the typed surface does not serve.
 *
 * Handed over whole rather than behind one more wrapper: a consumer reaching
 * for `pins.add`, `files.upload` or whatever Slack ships next should not have
 * to wait for this feature to model it. What they get is the client THIS
 * feature configured — bounded retry policy, request timeout, and the SDK's
 * per-instance rate-limit queue shared with every other caller — instead of
 * `new WebClient(token)`, where one rate-limited call blocks for ~30 minutes
 * and raises nothing.
 *
 * `undefined` rather than a throw when no bot token is in scope, matching
 * `postMessage`: a workspace that never configured Slack gets "not available"
 * and decides for itself, rather than an exception from an import.
 *
 * Note this bypasses the chat surface. A message posted through here is not
 * rationed, not rendered through the `markdown` block, and not counted by the
 * one-answer-per-turn rule.
 */
export const webClient = (): WebClient | undefined => resolveClient()?.raw;

/**
 * The implementation, parameterised by the client.
 *
 * Split out because the default path builds its own client from the
 * environment — deliberately, so a schedule can post with no chat surface
 * running — and `@slack/web-api` v7 is axios-based, so there is no transport
 * a test can stand in front of. This is the seam.
 */
export const makePostMessage =
  (slack: SlackClientShape) =>
  async (input: SlackPostMessageInput): Promise<SlackPostMessageResult> => {
    try {
      // Through `raw` rather than the typed method: this surface needs the
      // unfurl flags and Block Kit passthrough the port does not model.
      // Capped for the same reason the chat surface caps: Slack rejects an
      // over-long or over-long-block message outright, so an uncapped caller
      // gets a hard failure where a trimmed post would have done the job.
      const response = await slack.raw.chat.postMessage({
        channel: input.channel,
        text: withinSlackLimit(input.text),
        unfurl_links: input.unfurlLinks ?? false,
        unfurl_media: input.unfurlMedia ?? false,
        ...(input.blocks === undefined
          ? {}
          : { blocks: [...capBlocks(input.blocks)] }),
        ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
      });
      return {
        channel: response.channel ?? input.channel,
        ok: true,
        ...(response.ts === undefined ? {} : { ts: response.ts }),
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        ok: false,
      };
    }
  };

/**
 * The `use("slack")` entry point. Resolves the env-backed client on first
 * call and reports a missing token as a result rather than throwing.
 */
export const postMessage = (
  input: SlackPostMessageInput
): Promise<SlackPostMessageResult> => {
  const slack = resolveClient();
  return slack === undefined
    ? Promise.resolve({
        error: "SLACK_BOT_TOKEN is not set",
        ok: false,
      })
    : makePostMessage(slack)(input);
};

/**
 * Register a handler for a custom button, by action id.
 *
 * Re-exported here so `use("slack")` is the whole public surface: a consumer
 * posts a button with `postMessage({ blocks })` and answers the click with
 * this, without importing anything from inside the feature.
 *
 * Unlike `postMessage`, this needs no token and no running surface — it
 * writes to a registry the surface drains at boot, and wires straight through
 * if the surface is already up.
 */
export {
  onButton,
  RESERVED_ACTION_PREFIX,
  registeredButtonIds,
} from "./interactions/custom.ts";
export type {
  SlackButtonClick,
  SlackButtonHandler,
} from "./interactions/custom.ts";

/**
 * A Block Kit button element, with Slack's label and value ceilings applied.
 * Handed over so a consumer does not have to rebuild the shape — or discover
 * the truncation rules by having Slack reject the message.
 */
export { actions, button } from "./helpers/block-kit/blocks.ts";
