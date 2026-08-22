/**
 * graph-source.ts — a diagram as one line-per-edge string.
 *
 * The node/edge JSON is a schema the model has to be taught. This is a syntax
 * it already knows: Mermaid's flowchart grammar, which is in every model's
 * training data, so it writes one without being shown the shape.
 *
 * Only the grammar is borrowed, not the renderer. Mermaid measures text through
 * a real browser layout engine — `mermaid-cli` ships Chromium for exactly that
 * — and a chat surface that can be taken down by a headless browser is the
 * thing this feature has already been burned by twice. Parsed here, laid out by
 * `flow.ts` as before.
 *
 * The supported subset is deliberately small:
 *
 *   A[Boots] --> B{Bundled?}
 *   B -->|yes| C[Copy to temp]
 *   B -->|no| D[Load in place]
 *
 * `[]` is a step, `{}` a decision, `()` a terminus. A bare id with no brackets
 * is a node whose label is its id.
 */

import type { FlowEdge, FlowNode } from "./flow.ts";

/** `A[Label]`, `A{Label}`, `A(Label)`, or a bare `A`. */
const NODE = /^([A-Za-z0-9_.-]+)(?:(\[|\{|\()(.*?)(\]|\}|\)))?$/u;

/**
 * Labels are escaped before they reach the SVG, so `<br/>` arrives as the
 * literal four characters rather than a line break — Mermaid habits produce
 * it constantly. Dropped here rather than rendered, since a visible tag in a
 * box reads as a bug in the chart.
 */
const stripHtml = (label: string): string =>
  label
    .replaceAll(/<br\s*\/?>/giu, " ")
    .replaceAll(/<[^>]*>/gu, "")
    .trim();

/** `-->`, `---`, or either carrying a `|label|`. Global: a line may chain. */
const EDGE = /\s*-{2,3}>?\s*(?:\|([^|]*)\|)?\s*/gu;

const HEADER = /^\s*(?:flowchart|graph)\b/iu;

const SHAPE_KIND: Readonly<Record<string, FlowNode["kind"]>> = {
  "[": "step",
  "{": "decision",
  "(": "start",
};

interface Parsed {
  readonly edges: readonly FlowEdge[];
  readonly nodes: readonly FlowNode[];
}

/**
 * One side of an arrow, recorded so a later mention of the same id does not
 * overwrite a label with a bare reference.
 */
const readNode = (
  raw: string,
  into: Map<string, FlowNode>
): string | undefined => {
  const match = NODE.exec(raw.trim());
  if (match === null) {
    return undefined;
  }
  const [, id, open, label] = match;
  if (id === undefined) {
    return undefined;
  }
  const existing = into.get(id);
  const named = open !== undefined && (label ?? "").trim() !== "";
  if (existing === undefined || named) {
    into.set(id, {
      id,
      kind: open === undefined ? existing?.kind : SHAPE_KIND[open],
      label: named ? stripHtml(label ?? "") : (existing?.label ?? id),
    });
  }
  return id;
};

/**
 * Parse the subset. Anything unrecognised is skipped rather than failing: a
 * diagram missing one line still reads, where an error message does not.
 */
export const parseGraphSource = (source: string): Parsed => {
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];

  let pending: string | undefined;
  for (const raw of source.split("\n")) {
    const line = raw.trim().replace(/;$/u, "");
    if (line === "" || HEADER.test(line) || line.startsWith("%%")) {
      continue;
    }
    // A line can chain: `A --> B --> C`. Split on every arrow and link each
    // consecutive pair, so a chain is not read as one enormous node.
    const arrows = [...line.matchAll(EDGE)];
    if (arrows.length === 0) {
      readNode(line, nodes);
      continue;
    }
    let cursor = 0;
    let previous: string | undefined;
    for (const arrow of [...arrows, undefined]) {
      const end = arrow === undefined ? line.length : arrow.index;
      const id = readNode(line.slice(cursor, end), nodes);
      if (previous !== undefined && id !== undefined) {
        const label = (pending ?? "").trim();
        edges.push({
          from: previous,
          to: id,
          ...(label === "" ? {} : { label }),
        });
      }
      previous = id ?? previous;
      pending = arrow?.[1];
      cursor =
        arrow === undefined ? line.length : arrow.index + arrow[0].length;
    }
  }

  return {
    edges,
    nodes: [...nodes.values()],
  };
};
