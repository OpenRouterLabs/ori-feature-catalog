import { Schema } from "effect";

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

const ChartBodySchema = Schema.Struct({
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
export type ChartBody = typeof ChartBodySchema.Type;

export const decodeChartBody = Schema.decodeUnknownResult(ChartBodySchema);

export const UNREADABLE_BODY =
  "expected { channel, thread_ts, title, kind: bars|flow, and rows|graph to match }";

export type ChartRow = typeof Row.Type;

export type ChartDrawing = {
  readonly edges: readonly FlowEdgeInput[];
  readonly nodes: readonly FlowNodeInput[];
};

/** The rows a thread reader can still take in; a longer set is cut. */
export const chartRows = (body: ChartBody): readonly ChartRow[] =>
  (body.rows ?? []).slice(0, MAX_ROWS);

/** A graph source describes the nodes and edges the explicit fields carry. */
export const chartDrawing = (body: ChartBody): ChartDrawing =>
  body.graph === undefined
    ? {
        edges: body.edges ?? [],
        nodes: body.nodes ?? [],
      }
    : parseGraphSource(body.graph);

/** Why a flow chart of this shape would come out unreadable, when it would. */
export const flowRefusal = (drawing: ChartDrawing): string | undefined => {
  const { edges, nodes } = drawing;
  if (nodes.length > MAX_NODES) {
    return `${nodes.length} nodes is more than a flow chart can carry (max ${MAX_NODES}) — split it into two charts rather than losing the tail`;
  }
  const widest = widestRow(nodes, edges);
  if (widest > MAX_ROW_WIDTH) {
    return `${widest} boxes would share one row (max ${MAX_ROW_WIDTH}) and their labels would overlap — that shape is a markdown table, not a flow chart`;
  }
  return undefined;
};

/** Why there is nothing to post: no thread to post into, or nothing to draw. */
export const emptyRefusal = (input: {
  readonly body: ChartBody;
  readonly drawing: ChartDrawing;
  readonly rows: readonly ChartRow[];
}): string | undefined => {
  const counts = {
    bars: input.rows.length,
    flow: input.drawing.nodes.length,
  };
  return counts[input.body.kind] === 0 ||
    input.body.channel === "" ||
    input.body.thread_ts === ""
    ? "channel, thread_ts and at least one row are required"
    : undefined;
};

export const renderChartSvg = (input: {
  readonly drawing: ChartDrawing;
  readonly kind: "bars" | "flow";
  readonly rows: readonly ChartRow[];
  readonly title: string;
}): string => {
  if (input.kind === "flow") {
    return flowChartSvg({
      edges: input.drawing.edges,
      nodes: input.drawing.nodes,
      title: input.title,
    });
  }
  return barChartSvg({
    rows: input.rows,
    title: input.title,
  });
};

const ChartRequestSchema = Schema.Struct({
  channel: Schema.String,
  svg: Schema.String,
  team: Schema.UndefinedOr(Schema.String),
  threadTs: Schema.String,
  title: Schema.String,
});

export type ChartRequest = typeof ChartRequestSchema.Type;

export type ChartParse =
  | { readonly ok: true; readonly request: ChartRequest }
  | { readonly ok: false; readonly error: string };
