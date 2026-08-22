/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * chart-route.ts — the loopback route behind the `slack-chart` skill.
 *
 * Renders the SVG and uploads it into the thread. Unlike a status this does
 * not touch the progress message: a chart is part of the answer, and lands as
 * its own file so it survives the progress message being removed.
 */

import { Effect, Result } from "effect";

import type { ChartRequest } from "../../helpers/charts/chart-request.ts";
import type { MessageReplyShape } from "../../message-reply/reply.ts";
import type { ThreadRef } from "../../thread/thread.ts";

import { parseChartBody } from "../../helpers/charts/chart-request.ts";
import { svgToPng } from "../../helpers/charts/rasterise.ts";
import { loopbackRoute, refuse } from "./loopback-route.ts";

const HTTP_BAD_GATEWAY = 502;
const HTTP_UNPROCESSABLE = 422;

/** Long enough to recognise, short of any filesystem limit. */
const MAX_FILENAME_CHARS = 48;

/** A thrown non-Error still has to produce a sentence the caller can read. */
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

type Rendered =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly png: Blob };

/**
 * Render, reporting failure instead of raising it.
 *
 * resvg happily produces a valid PNG with zero glyphs when it resolves no
 * font, so "it did not throw" is not "it drew something". A caller that hears
 * the reason can fall back to text; one that gets a blank image cannot.
 */
const render = async (svg: string): Promise<Rendered> =>
  await svgToPng(svg).then(
    (png): Rendered => ({
      ok: true,
      png,
    }),
    (error: unknown): Rendered => ({
      ok: false,
      reason: describeError(error),
    })
  );

/** Upload, logging Slack's refusal rather than failing the whole route. */
const upload = async (
  reply: MessageReplyShape,
  file: { readonly png: Blob; readonly title: string }
): Promise<boolean> =>
  await Effect.runPromise(
    reply
      .attach({
        content: file.png,
        filename: `${file.title.replaceAll(/[^\w-]/gu, "-").slice(0, MAX_FILENAME_CHARS)}.png`,
        title: file.title,
      })
      .pipe(
        Effect.andThen(Effect.succeed(true)),
        Effect.catchCause((cause) =>
          Effect.logError("[slack] could not upload the chart", cause).pipe(
            Effect.andThen(Effect.succeed(false))
          )
        )
      )
  );

export const makeChartRoute = (deps: {
  readonly replyFor: (ref: ThreadRef) => Promise<MessageReplyShape>;
  readonly workspaceTeamId: string;
}): ((request: Request) => Promise<Response>) =>
  loopbackRoute<ChartRequest, Record<string, never>>({
    // A mermaid source or 24 rows of data; anything larger is not a chart.
    capKiB: 64,
    handle: async ({ ref, request }) => {
      const reply = await deps.replyFor(ref);

      const rendered = await render(request.svg);
      if (!rendered.ok) {
        // 422 rather than 500: the renderer refused THIS spec, and the
        // sentence says which part of it.
        return refuse(
          HTTP_UNPROCESSABLE,
          `could not render the chart: ${rendered.reason}`
        );
      }

      return (await upload(reply, {
        png: rendered.png,
        title: request.title,
      }))
        ? Result.succeed({})
        : refuse(HTTP_BAD_GATEWAY, "Slack refused the upload");
    },
    parse: (raw): Result.Result<ChartRequest, string> => {
      const parsed = parseChartBody(raw);
      return parsed.ok
        ? Result.succeed(parsed.request)
        : Result.fail(parsed.error);
    },
    workspaceTeamId: deps.workspaceTeamId,
  });
