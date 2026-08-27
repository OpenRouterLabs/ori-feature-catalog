/**
 * index.ts — everything `client/` offers the rest of the surface.
 *
 * This folder is the only place that talks to Slack's Web API and to Bolt.
 * Callers outside it import from here rather than reaching for a file inside,
 * so the folder can be rearranged without a rename rippling through the
 * feature. Modules WITHIN `client/` still import each other directly — a
 * folder importing its own barrel is a cycle waiting to happen.
 *
 * `client-test-support.ts` is deliberately absent: tests import it by path,
 * and a fake has no place in the production surface.
 */

export type { PostedMessage, SlackClientShape } from "./client.ts";
export {
  SlackApiError,
  SlackClient,
  SlackConfigError,
} from "./client.ts";
export {
  makeConfiguredWebClient,
  makeSlackClientFromToken,
  readSlackBotToken,
  SlackClientLive,
} from "./client-live.ts";
export { goLive, makeBoltApp, makeStop } from "./bolt-lifecycle.ts";
export type {
  RawAssistantThreadStarted,
  RawSlackMessage,
} from "./listeners.ts";
export { readViewSubmissionPayload, registerListeners } from "./listeners.ts";
export { SlackReceiver } from "./receiver.ts";
export { makeSurfaceEventHandlers } from "./surface-events.ts";
