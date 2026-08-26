/**
 * chart-request.ts — the wire shape the chart skill posts.
 *
 * Decoded once here so the route never guesses at a malformed body, and so the
 * skill and the surface agree on one contract rather than two.
 */

import { Result, Schema } from "effect";

import type {
  FlowEdge as FlowEdgeInput,
  FlowNode as FlowNodeInput,
} from "./flow.ts";

import { barChartSvg } from "./charts.ts";
import { flowChartSvg, MAX_NODES, MAX_ROW_WIDTH, widestRow } from "./flow.ts";
import { parseGraphSource } from "./graph-source.ts";

/** Enough for any chart worth reading in a thread. */
const MAX_ROWS = 24;

const Row = Schema.Struct({
  label: Schema.String,
  value: Schema.Number,
});

const FlowNode = Schema.Struct({
  detail: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  id: Schema.String,
  kind: Schema.optionalKey(
    Schema.UndefinedOr(
      Schema.Literals(["start", "step", "decision", "end", "error"])
    )
  ),
  label: Schema.String,
});

const FlowEdge = Schema.Struct({
  from: Schema.String,
  label: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  to: Schema.String,
});

const ChartBody = Schema.Struct({
  channel: Schema.String,
  /** Mermaid flowchart syntax — the model writes a diagram, not a schema. */
  graph: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  edges: Schema.optionalKey(Schema.UndefinedOr(Schema.Array(FlowEdge))),
  kind: Schema.Literals(["bars", "flow"]),
  nodes: Schema.optionalKey(Schema.UndefinedOr(Schema.Array(FlowNode))),
  rows: Schema.optionalKey(Schema.UndefinedOr(Schema.Array(Row))),
  team: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  thread_ts: Schema.String,
  title: Schema.String,
});
const decodeBody = Schema.decodeUnknownResult(ChartBody);

const render = (input: {
  readonly edges: readonly FlowEdgeInput[];
  readonly kind: "bars" | "flow";
  readonly nodes: readonly FlowNodeInput[];
  readonly rows: readonly { label: string; value: number }[];
  readonly title: string;
}): string => {
  if (input.kind === "flow") {
    return flowChartSvg({
      edges: input.edges,
      nodes: input.nodes,
      title: input.title,
    });
  }
  return barChartSvg({
    rows: input.rows,
    title: input.title,
  });
};

export interface ChartRequest {
  readonly channel: string;
  readonly svg: string;
  readonly team: string | undefined;
  readonly threadTs: string;
  readonly title: string;
}

type ChartParse =
  | { readonly ok: true; readonly request: ChartRequest }
  | { readonly ok: false; readonly error: string };

/**
 * Decode a chart request and render it in one step.
 *
 * Rendering here rather than in the route keeps the only place that knows both
 * chart kinds next to the builders themselves.
 */
export const parseChartBody = (raw: unknown): ChartParse =>
  Result.match(decodeBody(raw), {
    onFailure: (): ChartParse => ({
      error:
        "expected { channel, thread_ts, title, kind: bars|flow, and rows|graph to match }",
      ok: false,
    }),
    onSuccess: (decoded): ChartParse => {
      const rows = (decoded.rows ?? []).slice(0, MAX_ROWS);
      const drawn =
        decoded.graph === undefined
          ? {
              edges: decoded.edges ?? [],
              nodes: decoded.nodes ?? [],
            }
          : parseGraphSource(decoded.graph);
      const nodes = drawn.nodes.slice(0, MAX_NODES);
      const { edges } = drawn;
      const counts = {
        bars: rows.length,
        flow: nodes.length,
      };
      // A wide fan-out is a table with the parent as its heading, and drawn
      // as a flow its labels overlap into an unreadable smear. Refused rather
      // than rendered, because the model can write the table instead and only
      // will if it is told.
      if (decoded.kind === "flow") {
        const widest = widestRow(nodes, edges);
        if (widest > MAX_ROW_WIDTH) {
          return {
            error: `${widest} boxes would share one row (max ${MAX_ROW_WIDTH}) and their labels would overlap — that shape is a markdown table, not a flow chart`,
            ok: false,
          };
        }
      }

      const empty = counts[decoded.kind];
      if (empty === 0 || decoded.channel === "" || decoded.thread_ts === "") {
        return {
          error: "channel, thread_ts and at least one row are required",
          ok: false,
        };
      }

      return {
        ok: true,
        request: {
          channel: decoded.channel,
          svg: render({
            edges,
            kind: decoded.kind,
            nodes,
            rows,
            title: decoded.title,
          }),
          team: decoded.team,
          threadTs: decoded.thread_ts,
          title: decoded.title,
        },
      };
    },
  });
