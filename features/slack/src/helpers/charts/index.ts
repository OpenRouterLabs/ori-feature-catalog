import { Effect, Result } from "effect";

import type { ChartParse, ChartRow } from "./chart-request.ts";
import type { ChartRenderFailure } from "./rasterise.ts";

import {
  chartDrawing,
  chartRows,
  decodeChartBody,
  emptyRefusal,
  flowRefusal,
  renderChartSvg,
  UNREADABLE_BODY,
} from "./chart-request.ts";
import { svgToPng } from "./rasterise.ts";

export type RenderedChart =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly png: Blob };

export type ChartPipelineShape = {
  /** A posted body becomes a drawn request, or the reason it cannot be. */
  readonly parse: (raw: unknown) => ChartParse;
  /** A drawn request becomes a PNG, or the reason it could not be one. */
  readonly render: (svg: string) => Effect.Effect<RenderedChart>;
};

const parseChart = (raw: unknown): ChartParse =>
  Result.match(decodeChartBody(raw), {
    onFailure: (): ChartParse => ({
      error: UNREADABLE_BODY,
      ok: false,
    }),
    onSuccess: (body): ChartParse => {
      const rows: readonly ChartRow[] = chartRows(body);
      const drawing = chartDrawing(body);

      const refusal =
        (body.kind === "flow" ? flowRefusal(drawing) : undefined) ??
        emptyRefusal({
          body,
          drawing,
          rows,
        });
      if (refusal !== undefined) {
        return {
          error: refusal,
          ok: false,
        };
      }

      return {
        ok: true,
        request: {
          channel: body.channel,
          svg: renderChartSvg({
            drawing,
            kind: body.kind,
            rows,
            title: body.title,
          }),
          team: body.team,
          threadTs: body.thread_ts,
          title: body.title,
        },
      };
    },
  });

const renderChart = Effect.fn("Slack.chart.render")(function* (
  svg: string
): Effect.fn.Return<RenderedChart> {
  return yield* svgToPng(svg).pipe(
    Effect.map((png): RenderedChart => ({
      ok: true,
      png,
    })),
    Effect.catch((error: ChartRenderFailure) =>
      Effect.succeed<RenderedChart>({
        ok: false,
        reason: error.message,
      })
    )
  );
});

export const makeChartPipeline = (): ChartPipelineShape => ({
  parse: parseChart,
  render: renderChart,
});
