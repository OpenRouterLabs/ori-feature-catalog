import { charsThatFit, escape, truncate, wrapText } from "./text.ts";

import { Schema } from "effect";

const WIDTH = 760;
const NODE_HEIGHT = 52;
const ROW_GAP = 34;
const NODE_GAP = 16;
const PADDING = 16;
const TITLE_HEIGHT = 52;

const EDGE_LABEL_LIFT = 5;
const EDGE_LABEL_LINE_HEIGHT = 12;
const EDGE_LABEL_WIDTH = WIDTH / 3;
const MAX_EDGE_LABEL_LINES = 2;

const MAX_TITLE_CHARS = 60;

const TEXT_INSET = 12;
const LABEL_LINE_HEIGHT = 17;
const DETAIL_LINE_HEIGHT = 13;
const MAX_LABEL_LINES = 4;
const MAX_DETAIL_LINES = 2;

export const MAX_NODES = 30;

export const MAX_ROW_WIDTH = 4;

const BACKGROUND = "#1a1d21";
const CARD_STROKE = "#33383f";
const RULE_FILL = "#2c3138";
const TEXT_FILL = "#9aa1ab";
const TITLE_FILL = "#e8eaed";
const EDGE_FILL = "#59606b";

const KIND_FILL = {
  decision: "#3a3358",
  end: "#1f3a2e",
  error: "#3d2626",
  start: "#1f3348",
  step: "#23272d",
} as const;

const KIND_STROKE = {
  decision: "#7a6dcd",
  end: "#3f9e6a",
  error: "#c2564f",
  start: "#5eb0ff",
  step: "#333941",
} as const;

export const FlowNodeSchema = Schema.Struct({
  detail: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  id: Schema.String,
  kind: Schema.optionalKey(
    Schema.UndefinedOr(
      Schema.Literals(["decision", "end", "error", "start", "step"])
    )
  ),
  label: Schema.String,
});

export type FlowNode = typeof FlowNodeSchema.Type;

type AssertAssignable<A extends B, B> = A;

type FlowNodeKindsMatchTheirFills = AssertAssignable<
  NonNullable<FlowNode["kind"]>,
  keyof typeof KIND_FILL
>;

type FillsMatchTheirFlowNodeKinds = AssertAssignable<
  keyof typeof KIND_FILL,
  NonNullable<FlowNode["kind"]>
>;

export type { FlowNodeKindsMatchTheirFills, FillsMatchTheirFlowNodeKinds };

export const FlowEdgeSchema = Schema.Struct({
  from: Schema.String,
  label: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  to: Schema.String,
});

export type FlowEdge = typeof FlowEdgeSchema.Type;

const PlacedSchema = Schema.Struct({
  detail: Schema.Array(Schema.String),
  height: Schema.Number,
  label: Schema.Array(Schema.String),
  node: FlowNodeSchema,
  row: Schema.Number,
  width: Schema.Number,
  x: Schema.Number,
  y: Schema.Number,
});

type Placed = typeof PlacedSchema.Type;

const rowsOf = (
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[]
): ReadonlyMap<string, number> => {
  const row = new Map(nodes.map((node) => [node.id, 0]));
  for (const _pass of nodes) {
    let moved = false;
    for (const edge of edges) {
      const from = row.get(edge.from);
      const to = row.get(edge.to);
      if (from !== undefined && to !== undefined && to < from + 1) {
        row.set(edge.to, from + 1);
        moved = true;
      }
    }
    if (!moved) {
      break;
    }
  }
  return row;
};

export const widestRow = (
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[]
): number => {
  const rows = rowsOf(nodes, edges);
  const perRow = new Map<number, number>();
  for (const node of nodes) {
    const row = rows.get(node.id) ?? 0;
    perRow.set(row, (perRow.get(row) ?? 0) + 1);
  }
  return Math.max(...perRow.values(), 0);
};

const placeNodes = (
  nodes: readonly FlowNode[],
  rows: ReadonlyMap<string, number>
): readonly Placed[] => {
  const byRow = new Map<number, FlowNode[]>();
  for (const node of nodes) {
    const row = rows.get(node.id) ?? 0;
    byRow.set(row, [...(byRow.get(row) ?? []), node]);
  }

  const placed: Placed[] = [];
  const usable = WIDTH - PADDING * 2;

  let y = TITLE_HEIGHT;
  for (const row of [...byRow.keys()].sort((left, right) => left - right)) {
    const rowNodes = byRow.get(row) ?? [];
    const width = Math.floor(
      (usable - NODE_GAP * (rowNodes.length - 1)) / rowNodes.length
    );
    const onThisRow = rowNodes.map((node, index) => ({
      ...measure(node, width),
      node,
      row,
      width,
      x: PADDING + index * (width + NODE_GAP),
      y,
    }));
    placed.push(...onThisRow);
    y += Math.max(...onThisRow.map((item) => item.height)) + ROW_GAP;
  }
  return placed;
};

const measure = (
  node: FlowNode,
  width: number
): Pick<Placed, "detail" | "height" | "label"> => {
  const usable = width - TEXT_INSET * 2;
  const label = wrapText(node.label, charsThatFit(usable, 14)).slice(
    0,
    MAX_LABEL_LINES
  );
  const detail =
    node.detail === undefined || node.detail === ""
      ? []
      : wrapText(node.detail, charsThatFit(usable, 11)).slice(
          0,
          MAX_DETAIL_LINES
        );
  const text =
    label.length * LABEL_LINE_HEIGHT + detail.length * DETAIL_LINE_HEIGHT;
  return {
    detail,
    height: Math.max(NODE_HEIGHT, text + TEXT_INSET * 2),
    label,
  };
};

const nodeSvg = (placed: Placed): string => {
  const { detail, height, label } = placed;
  const kind = placed.node.kind ?? "step";
  const centre = placed.x + placed.width / 2;

  const text =
    label.length * LABEL_LINE_HEIGHT + detail.length * DETAIL_LINE_HEIGHT;
  let baseline = placed.y + (height - text) / 2 + LABEL_LINE_HEIGHT - 4;

  const parts = [
    `<rect x="${placed.x}" y="${placed.y}" width="${placed.width}" height="${height}" fill="${KIND_FILL[kind]}" stroke="${KIND_STROKE[kind]}" rx="8"/>`,
  ];
  for (const line of label) {
    parts.push(
      `<text x="${centre}" y="${baseline}" text-anchor="middle" fill="${TITLE_FILL}" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="14" font-weight="600">${escape(line)}</text>`
    );
    baseline += LABEL_LINE_HEIGHT;
  }
  for (const line of detail) {
    parts.push(
      `<text x="${centre}" y="${baseline}" text-anchor="middle" fill="${TEXT_FILL}" font-family="monospace" font-size="11">${escape(line)}</text>`
    );
    baseline += DETAIL_LINE_HEIGHT;
  }
  return parts.join("");
};

const edgeSvg = (from: Placed, to: Placed, label: string): string => {
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height;
  const endX = to.x + to.width / 2;
  const endY = to.y;
  const midY = startY + (endY - startY) / 2;
  const path = `M ${startX} ${startY} L ${startX} ${midY} L ${endX} ${midY} L ${endX} ${endY}`;
  const parts = [
    `<path d="${path}" fill="none" stroke="${EDGE_FILL}" stroke-width="1.5" marker-end="url(#arrow)"/>`,
  ];
  if (label !== "") {
    parts.push(
      ...wrapText(label, charsThatFit(EDGE_LABEL_WIDTH, 10))
        .slice(0, MAX_EDGE_LABEL_LINES)
        .map(
          (line, index, all) =>
            `<text x="${(startX + endX) / 2}" y="${midY - EDGE_LABEL_LIFT - (all.length - 1 - index) * EDGE_LABEL_LINE_HEIGHT}" text-anchor="middle" fill="${TEXT_FILL}" font-family="monospace" font-size="10">${escape(line)}</text>`
        )
    );
  }
  return parts.join("");
};

export const flowChartSvg = (input: {
  readonly edges: readonly FlowEdge[];
  readonly nodes: readonly FlowNode[];
  readonly title: string;
}): string => {
  const nodes = input.nodes.slice(0, MAX_NODES);
  const known = new Set(nodes.map((node) => node.id));
  const edges = input.edges.filter(
    (edge) => known.has(edge.from) && known.has(edge.to)
  );

  const placed = placeNodes(nodes, rowsOf(nodes, edges));
  const byId = new Map(placed.map((item) => [item.node.id, item]));
  const height =
    Math.max(
      TITLE_HEIGHT + NODE_HEIGHT,
      ...placed.map((item) => item.y + item.height)
    ) + PADDING;

  const arrows = edges.flatMap((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    return from === undefined || to === undefined || to.row <= from.row
      ? []
      : [edgeSvg(from, to, edge.label ?? "")];
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">`,
    `<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${EDGE_FILL}"/></marker></defs>`,
    `<rect x="0" y="0" width="${WIDTH}" height="${height}" fill="${BACKGROUND}" stroke="${CARD_STROKE}" rx="10"/>`,
    `<text x="${PADDING}" y="26" fill="${TITLE_FILL}" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="16" font-weight="600">${escape(truncate(input.title, MAX_TITLE_CHARS))}</text>`,
    `<rect x="${PADDING}" y="36" width="${WIDTH - PADDING * 2}" height="1" fill="${RULE_FILL}"/>`,
    ...arrows,
    ...placed.map((item) => nodeSvg(item)),
    "</svg>",
  ].join("");
};
