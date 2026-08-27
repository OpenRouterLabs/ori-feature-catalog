/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * chart-route.ts — the loopback route behind the `slack-chart` skill.
 *
 * Renders the SVG and uploads it into the thread. Unlike a status this does
 * not touch the progress message: a chart is part of the answer, and lands as
 * its own file so it survives the progress message being removed.
 *
 * An HTTP handler is a real edge, so the Effect is run exactly once — at the
 * bottom of this file, where the route hands Bun back a `Promise<Response>`.
 * Everything above that line stays in the Effect: rendering, uploading, and
 * the refusal each step can produce.
 */

import { Effect, Result } from "effect";

import type { ChartRequest } from "../../helpers/charts/chart-request.ts";
import type { ChartRenderFailure } from "../../helpers/charts/rasterise.ts";
import type { MessageReplyShape } from "../../message-reply/reply.ts";
import type { ThreadRef } from "../../thread/thread.ts";
import type { Refusal } from "./loopback-route.ts";

import { parseChartBody } from "../../helpers/charts/chart-request.ts";
import { svgToPng } from "../../helpers/charts/rasterise.ts";
import { loopbackRoute, refuse } from "./loopback-route.ts";

const HTTP_BAD_GATEWAY = 502;
const HTTP_UNPROCESSABLE = 422;

/** Long enough to recognise, short of any filesystem limit. */
const MAX_FILENAME_CHARS = 48;

type Rendered =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly png: Blob };

/**
 * Render, reporting failure instead of raising it.
 *
 * resvg happily produces a valid PNG with zero glyphs when it resolves no
 * font, so "it did not throw" is not "it drew something". A caller that hears
 * the reason can fall back to text; one that gets a blank image cannot.
 *
 * Every refusal the renderer has is in its error channel now, so this catches
 * a union it can name instead of flattening whatever was thrown. The three
 * tags — no font, no binding, this SVG — read the same to the person who
 * asked for the chart, and are one `catchTag` apart if that ever changes.
 */
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

/** Upload, logging Slack's refusal rather than failing the whole route. */
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

/**
 * The whole request, in one fiber.
 *
 * `replyFor` stays a Promise: it is built outside this feature's Effect graph
 * and handed in, so it is taken in through `Effect.promise` rather than
 * reshaped from here.
 */
const handleChart = Effect.fn("Slack.chart.handle")(function* (input: {
  readonly deps: ChartRouteDeps;
  readonly ref: ThreadRef;
  readonly request: ChartRequest;
}): Effect.fn.Return<Result.Result<Record<string, never>, Refusal>> {
  const reply = yield* Effect.promise(() => input.deps.replyFor(input.ref));

  const rendered = yield* render(input.request.svg);
  if (!rendered.ok) {
    // 422 rather than 500: the renderer refused THIS spec, and the
    // sentence says which part of it.
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
    // A mermaid source or 24 rows of data; anything larger is not a chart.
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
