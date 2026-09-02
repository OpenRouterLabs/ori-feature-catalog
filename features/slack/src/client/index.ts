import { Layer } from "effect";

import { makeSlackClientFromToken } from "./client-live.ts";
import { SlackClient } from "./client.ts";

export type ClientServices = SlackClient;

export const SlackClientLayer = (token: string): Layer.Layer<ClientServices> =>
  Layer.sync(SlackClient)(() => SlackClient.of(makeSlackClientFromToken(token)));

export * from "./client.ts";
export * from "./client-live.ts";
export * from "./proxy-agent.ts";
export * from "./receiver.ts";
