import type { FlowEdge, FlowNode } from "./flow.ts";

const NODE = /^([A-Za-z0-9_.-]+)(?:(\[|\{|\()(.*?)(\]|\}|\)))?$/u;

const stripHtml = (label: string): string =>
  label
    .replaceAll(/<br\s*\/?>/giu, " ")
    .replaceAll(/<[^>]*>/gu, "")
    .trim();

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

export const parseGraphSource = (source: string): Parsed => {
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];

  let pending: string | undefined;
  for (const raw of source.split("\n")) {
    const line = raw.trim().replace(/;$/u, "");
    if (line === "" || HEADER.test(line) || line.startsWith("%%")) {
      continue;
    }
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
