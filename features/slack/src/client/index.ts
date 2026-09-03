import { Context, Effect, Layer, Schema } from "effect";

import { makeSlackClientFromToken } from "./client-live.ts";
import { SlackClient } from "./client.ts";

const SlackClientLayerOptionsSchema = Schema.Struct({
  token: Schema.String,
});

type SlackClientLayerOptions = typeof SlackClientLayerOptionsSchema.Type;

class SlackClientConfig extends Context.Service<
  SlackClientConfig,
  SlackClientLayerOptions
>()("ori/slack/SlackClientConfig") {
  static readonly fromOptions = (
    options: SlackClientLayerOptions
  ): Layer.Layer<SlackClientConfig> =>
    Layer.effect(SlackClientConfig)(
      Effect.succeed(SlackClientConfig.of(options))
    );
}

export type ClientServices = SlackClient;

const slackClientImplementationLayer = Layer.effect(SlackClient)(
  Effect.gen(function* () {
    const config = yield* SlackClientConfig;
    return SlackClient.of(makeSlackClientFromToken(config.token));
  })
);

export const makeSlackClientLayer = (
  options: SlackClientLayerOptions
): Layer.Layer<ClientServices> =>
  slackClientImplementationLayer.pipe(
    Layer.provide(SlackClientConfig.fromOptions(options))
  );

export type { SlackClientLayerOptions };
