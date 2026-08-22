import { describe, expect, test } from "bun:test";

import { flowChartSvg } from "./flow.ts";

const post = {
  edges: [
    {
      from: "a",
      to: "b",
    },
    {
      from: "b",
      label: "blocked",
      to: "c",
    },
    {
      from: "b",
      label: "passes",
      to: "d",
    },
  ],
  nodes: [
    {
      id: "a",
      kind: "start" as const,
      label: "Turn starts",
    },
    {
      id: "b",
      kind: "decision" as const,
      label: "Lint gate",
    },
    {
      id: "c",
      kind: "error" as const,
      label: "Timed out",
    },
    {
      id: "d",
      kind: "end" as const,
      label: "Commit + PR",
    },
  ],
  title: "Why the run failed",
};

/** Every `y` a node box was drawn at, in document order. */
const nodeRows = (svg: string): number[] =>
  [...svg.matchAll(/<rect x="\d+" y="(\d+)" width="\d+" height="52"/gu)].map(
    (match) => Number(match[1])
  );

describe("flowChartSvg", () => {
  test("puts a node below everything that points at it", () => {
    const rows = nodeRows(flowChartSvg(post));

    expect(rows[0]).toBeLessThan(rows[1] ?? 0);
    expect(rows[1]).toBeLessThan(rows[2] ?? 0);
  });

  test("branches sit side by side, on the same row", () => {
    // Two arms out of one decision is the shape a plain ordered stack cannot
    // draw, and the whole reason this renderer exists.
    const rows = nodeRows(flowChartSvg(post));

    expect(rows[2]).toBe(rows[3] ?? -1);
  });

  test("carries the labels on the arrows, not only on the boxes", () => {
    const svg = flowChartSvg(post);

    expect(svg).toContain("blocked");
    expect(svg).toContain("passes");
  });

  test("colours a failure arm differently from a success", () => {
    // So the shape reads at a glance rather than only on reading it.
    const svg = flowChartSvg(post);

    expect(svg).toContain("#3d2626");
    expect(svg).toContain("#1f3a2e");
  });

  test("drops an edge naming a node that is not there", () => {
    // A typo in an id would otherwise throw mid-render, losing the picture.
    const svg = flowChartSvg({
      ...post,
      edges: [
        ...post.edges,
        {
          from: "a",
          to: "ghost",
        },
      ],
    });

    expect(svg).toContain("Turn starts");
  });

  test("a cycle renders rather than hanging", () => {
    // Depth is iterated to a fixed point, so a graph that points back at
    // itself must stop early instead of looping forever.
    const svg = flowChartSvg({
      edges: [
        {
          from: "a",
          to: "b",
        },
        {
          from: "b",
          to: "a",
        },
      ],
      nodes: [
        {
          id: "a",
          label: "one",
        },
        {
          id: "b",
          label: "two",
        },
      ],
      title: "cycle",
    });

    expect(svg).toContain("one");
  });

  test("a label cannot close a tag it sits inside", () => {
    const svg = flowChartSvg({
      edges: [],
      nodes: [
        {
          id: "a",
          label: "</text><script>alert(1)</script>",
        },
      ],
      title: "x",
    });

    expect(svg).not.toContain("<script>");
  });
});
