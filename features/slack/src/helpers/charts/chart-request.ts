import { Result, Schema } from "effect";

import type {
  FlowEdge as FlowEdgeInput,
  FlowNode as FlowNodeInput,
} from "./flow.ts";

import { barChartSvg } from "./charts.ts";
import { flowChartSvg, MAX_NODES, MAX_ROW_WIDTH, widestRow } from "./flow.ts";
import { parseGraphSource } from "./graph-source.ts";

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
      const { edges, nodes } = drawn;
      const counts = {
        bars: rows.length,
        flow: nodes.length,
      };
      if (decoded.kind === "flow") {
        if (nodes.length > MAX_NODES) {
          return {
            error: `${nodes.length} nodes is more than a flow chart can carry (max ${MAX_NODES}) — split it into two charts rather than losing the tail`,
            ok: false,
          };
        }
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
