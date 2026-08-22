/**
 * flow.ts — a flow chart: boxes, arrows, and branches.
 *
 * An ordered stack carries an ORDER and nothing else. A flow has a shape the
 * order alone cannot carry — two paths out of a check, a failure arm that
 * stops, two branches rejoining. That is the picture a "why did this fail" or
 * a "how does a request get here" answer actually wants, and it is why the
 * stack that used to live in `charts.ts` is gone: it was this, drawn worse.
 *
 * Laid out in ranks: a node sits one row below the deepest thing pointing at
 * it, and everything on a row shares it. That is enough structure for the
 * shapes a thread carries, and it needs no measuring pass.
 */

import { escape, truncate } from "./text.ts";

const WIDTH = 760;
const NODE_HEIGHT = 52;
const ROW_GAP = 34;
const NODE_GAP = 16;
const PADDING = 16;
const TITLE_HEIGHT = 52;

/** Baselines inside a box: centred alone, or stacked over a detail line. */
const LABEL_ALONE_Y = 31;
const LABEL_OVER_DETAIL_Y = 24;
const DETAIL_Y = 40;
/** Clear of the arrow it names. */
const EDGE_LABEL_LIFT = 5;

const MAX_LABEL_CHARS = 30;
const MAX_DETAIL_CHARS = 46;
const MAX_EDGE_LABEL_CHARS = 18;
const MAX_TITLE_CHARS = 60;

/** Past this a flow is a document, not a picture. */
export const MAX_NODES = 14;

/**
 * How many boxes may share a row before the picture stops being one.
 *
 * A row is centred across a fixed-width card, so every extra sibling makes
 * every label narrower. At nine — a fan-out from one node to nine checked
 * surfaces — the labels overlapped into a single unreadable smear: "ack
 * HMACaulttunnel proxykey-proxy allowsion ownership". That shape is a TABLE
 * with the parent as its heading, and drawing it as a flow loses the reader
 * both the words and the structure.
 *
 * Four fits the card at a readable size, and a genuine decision rarely
 * branches wider.
 */
export const MAX_ROW_WIDTH = 4;

const BACKGROUND = "#1a1d21";
const CARD_STROKE = "#33383f";
const RULE_FILL = "#2c3138";
const TEXT_FILL = "#9aa1ab";
const TITLE_FILL = "#e8eaed";
const EDGE_FILL = "#59606b";

/**
 * Colour carries the KIND, so a failure arm reads as one at a glance rather
 * than only on reading its label.
 */
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

export type FlowNodeKind = keyof typeof KIND_FILL;

export interface FlowNode {
  readonly detail?: string | undefined;
  readonly id: string;
  readonly kind?: FlowNodeKind | undefined;
  readonly label: string;
}

export interface FlowEdge {
  readonly from: string;
  readonly label?: string | undefined;
  readonly to: string;
}

interface Placed {
  readonly node: FlowNode;
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

/**
 * How deep each node sits: one below the deepest node pointing at it.
 *
 * Iterated to a fixed point rather than sorted topologically, because a cycle
 * must not hang the renderer — the pass is capped at the node count, which
 * settles any acyclic graph and merely stops early on a cyclic one.
 */
const rowsOf = (
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[]
): ReadonlyMap<string, number> => {
  const row = new Map(nodes.map((node) => [node.id, 0]));
  // Capped at the node count: that settles any acyclic graph, and merely
  // stops early on a cyclic one rather than looping forever.
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

/** The widest row this graph would draw, so a caller can refuse it. */
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

/** Place every node, centring each row across the card. */
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
  for (const [row, rowNodes] of byRow) {
    const width = Math.floor(
      (usable - NODE_GAP * (rowNodes.length - 1)) / rowNodes.length
    );
    for (const [index, node] of rowNodes.entries()) {
      placed.push({
        node,
        row,
        width,
        x: PADDING + index * (width + NODE_GAP),
        y: TITLE_HEIGHT + row * (NODE_HEIGHT + ROW_GAP),
      });
    }
  }
  return placed;
};

const nodeSvg = (placed: Placed): string => {
  const kind = placed.node.kind ?? "step";
  const detail = placed.node.detail ?? "";
  const centre = placed.x + placed.width / 2;
  const parts = [
    `<rect x="${placed.x}" y="${placed.y}" width="${placed.width}" height="${NODE_HEIGHT}" fill="${KIND_FILL[kind]}" stroke="${KIND_STROKE[kind]}" rx="8"/>`,
    `<text x="${centre}" y="${placed.y + (detail === "" ? LABEL_ALONE_Y : LABEL_OVER_DETAIL_Y)}" text-anchor="middle" fill="${TITLE_FILL}" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="14" font-weight="600">${escape(truncate(placed.node.label, MAX_LABEL_CHARS))}</text>`,
  ];
  if (detail !== "") {
    parts.push(
      `<text x="${centre}" y="${placed.y + DETAIL_Y}" text-anchor="middle" fill="${TEXT_FILL}" font-family="monospace" font-size="11">${escape(truncate(detail, MAX_DETAIL_CHARS))}</text>`
    );
  }
  return parts.join("");
};

/**
 * An edge, drawn as an elbow rather than a straight line.
 *
 * A diagonal between rows crosses whatever sits between them; leaving the
 * bottom, turning in the gap, and entering the top keeps every arrow in the
 * empty space the row gap exists to provide.
 */
const edgeSvg = (from: Placed, to: Placed, label: string): string => {
  const startX = from.x + from.width / 2;
  const startY = from.y + NODE_HEIGHT;
  const endX = to.x + to.width / 2;
  const endY = to.y;
  const midY = startY + (endY - startY) / 2;
  const path = `M ${startX} ${startY} L ${startX} ${midY} L ${endX} ${midY} L ${endX} ${endY}`;
  const parts = [
    `<path d="${path}" fill="none" stroke="${EDGE_FILL}" stroke-width="1.5" marker-end="url(#arrow)"/>`,
  ];
  if (label !== "") {
    parts.push(
      `<text x="${(startX + endX) / 2}" y="${midY - EDGE_LABEL_LIFT}" text-anchor="middle" fill="${TEXT_FILL}" font-family="monospace" font-size="10">${escape(truncate(label, MAX_EDGE_LABEL_CHARS))}</text>`
    );
  }
  return parts.join("");
};

/**
 * A flow chart, laid out top to bottom.
 *
 * Edges pointing UP are dropped rather than drawn: they are almost always a
 * mistake in the caller's graph, and one would be rendered as an arrow running
 * backwards through the rows above it.
 */
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
  const rowCount = Math.max(1, ...placed.map((item) => item.row + 1));
  const height =
    TITLE_HEIGHT + rowCount * NODE_HEIGHT + (rowCount - 1) * ROW_GAP + PADDING;

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
