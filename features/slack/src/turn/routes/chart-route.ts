import { Effect, Result, Schema } from "effect";

import type { ChartRequest } from "#src/helpers/charts/chart-request.ts";
import type { ChartPipelineShape } from "#src/helpers/charts/index.ts";
import type { MessageReplyShape } from "#src/message-reply/reply.ts";
import type { ThreadRef } from "#src/thread/thread.ts";
import type { Refusal } from "./loopback-route.ts";

import { makeChartPipeline } from "#src/helpers/charts/index.ts";
import { functionSchema } from "#src/schema-support.ts";
import { loopbackRoute, refuse } from "./loopback-route.ts";

const HTTP_BAD_GATEWAY = 502;
const HTTP_UNPROCESSABLE = 422;

const MAX_FILENAME_CHARS = 48;

const upload = Effect.fn("Slack.chart.upload")(function* (input: {
  readonly png: Blob;
  readonly reply: MessageReplyShape;
  readonly title: string;
}): Effect.fn.Return<boolean> {
  return yield* input.reply
    .attach({
      content: input.png,
      filename: `${input.title.replaceAll(/[^\w-]/gu, "-").slice(0, MAX_FILENAME_CHARS)}.png`,
      title: input.title,
    })
    .pipe(
      Effect.andThen(Effect.succeed(true)),
      Effect.catchCause((cause) =>
        Effect.logError("[slack] could not upload the chart", cause).pipe(
          Effect.andThen(Effect.succeed(false))
        )
      )
    );
});

const ChartRouteDepsSchema = Schema.Struct({
  replyFor: functionSchema<(ref: ThreadRef) => Promise<MessageReplyShape>>(
    "ChartRouteDeps.replyFor"
  ),
  workspaceTeamId: Schema.String,
});

type ChartRouteDeps = typeof ChartRouteDepsSchema.Type;

const handleChart = Effect.fn("Slack.chart.handle")(function* (input: {
  readonly charts: ChartPipelineShape;
  readonly deps: ChartRouteDeps;
  readonly ref: ThreadRef;
  readonly request: ChartRequest;
}): Effect.fn.Return<Result.Result<Record<string, never>, Refusal>> {
  const reply = yield* Effect.promise(() => input.deps.replyFor(input.ref));

  const rendered = yield* input.charts.render(input.request.svg);
  if (!rendered.ok) {
    return refuse(
      HTTP_UNPROCESSABLE,
      `could not render the chart: ${rendered.reason}`
    );
  }

  const uploaded = yield* upload({
    png: rendered.png,
    reply,
    title: input.request.title,
  });

  return uploaded
    ? Result.succeed({})
    : refuse(HTTP_BAD_GATEWAY, "Slack refused the upload");
});

export const makeChartRoute = (
  deps: ChartRouteDeps
): ((request: Request) => Promise<Response>) => {
  const charts = makeChartPipeline();
  return loopbackRoute<ChartRequest, Record<string, never>>({
    capKiB: 64,
    handle: ({ ref, request }) =>
      handleChart({
        charts,
        deps,
        ref,
        request,
      }),
    parse: (raw): Result.Result<ChartRequest, string> => {
      const parsed = charts.parse(raw);
      return parsed.ok
        ? Result.succeed(parsed.request)
        : Result.fail(parsed.error);
    },
    workspaceTeamId: deps.workspaceTeamId,
  });
};
