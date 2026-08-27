/**
 * index.ts — the Bolt-free half of `client/`, for the rest of the surface.
 *
 * `client.ts`, `client-live.ts` and `surface-events.ts` reach only
 * `@slack/web-api`. `listeners.ts`, `receiver.ts` and `bolt-lifecycle.ts`
 * import `@slack/bolt`, and they are deliberately NOT re-exported here:
 * feature.ts loads the runtime through a dynamic `import()` so Bolt stays out
 * of processes that never select this surface, and a barrel that pulled Bolt
 * in for anything wanting `SlackClient` would undo that. Those three are
 * imported by path, from the runtime that already needs them.
 *
 * `client-test-support.ts` is absent for a duller reason: tests import the
 * fake by path, and it has no place in the production surface.
 */

export type { PostedMessage, SlackClientShape } from "./client.ts";
export { SlackApiError, SlackClient, SlackConfigError } from "./client.ts";
export {
  makeConfiguredWebClient,
  makeSlackClientFromToken,
  readSlackBotToken,
  SlackClientLive,
} from "./client-live.ts";
export { makeSurfaceEventHandlers } from "./surface-events.ts";
