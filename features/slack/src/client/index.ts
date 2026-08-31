export type { PostedMessage, SlackClientShape } from "./client.ts";
export { SlackApiError, SlackClient, SlackConfigError } from "./client.ts";
export {
  makeConfiguredWebClient,
  makeSlackClientFromToken,
  readSlackBotToken,
  SlackClientLive,
} from "./client-live.ts";
export { makeSurfaceEventHandlers } from "./surface-events.ts";
