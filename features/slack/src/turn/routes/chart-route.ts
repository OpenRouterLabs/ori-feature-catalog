import { Effect, Result } from "effect";

import type { ChartRequest } from "#src/helpers/charts/chart-request.ts";
import type { ChartRenderFailure } from "#src/helpers/charts/rasterise.ts";
import type { MessageReplyShape } from "#src/message-reply/reply.ts";
import type { ThreadRef } from "#src/thread/thread.ts";
import type { Refusal } from "./loopback-route.ts";

import { parseChartBody } from "#src/helpers/charts/chart-request.ts";
import { svgToPng } from "#src/helpers/charts/rasterise.ts";
import { loopbackRoute, refuse } from "./loopback-route.ts";

const HTTP_BAD_GATEWAY = 502;
const HTTP_UNPROCESSABLE = 422;

const MAX_FILENAME_CHARS = 48;

type Rendered =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly png: Blob };

const render = Effect.fn("Slack.chart.render")(function* (
  svg: string
): Effect.fn.Return<Rendered> {
  return yield* svgToPng(svg).pipe(
    Effect.map((png): Rendered => ({
      ok: true,
      png,
    })),
    Effect.catch((error: ChartRenderFailure) =>
      Effect.succeed<Rendered>({
        ok: false,
        reason: error.message,
      })
    )
  );
});

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

interface ChartRouteDeps {
  readonly replyFor: (ref: ThreadRef) => Promise<MessageReplyShape>;
  readonly workspaceTeamId: string;
}

const handleChart = Effect.fn("Slack.chart.handle")(function* (input: {
  readonly deps: ChartRouteDeps;
  readonly ref: ThreadRef;
  readonly request: ChartRequest;
}): Effect.fn.Return<Result.Result<Record<string, never>, Refusal>> {
  const reply = yield* Effect.promise(() => input.deps.replyFor(input.ref));

  const rendered = yield* render(input.request.svg);
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
): ((request: Request) => Promise<Response>) =>
  loopbackRoute<ChartRequest, Record<string, never>>({
    capKiB: 64,
    handle: ({ ref, request }) =>
      handleChart({
        deps,
        ref,
        request,
      }),
    parse: (raw): Result.Result<ChartRequest, string> => {
      const parsed = parseChartBody(raw);
      return parsed.ok
        ? Result.succeed(parsed.request)
        : Result.fail(parsed.error);
    },
    workspaceTeamId: deps.workspaceTeamId,
  });
