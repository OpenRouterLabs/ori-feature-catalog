import { describe, expect, test } from "#src/test-support/effect-test.ts";

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
    const rows = nodeRows(flowChartSvg(post));

    expect(rows[2]).toBe(rows[3] ?? -1);
  });

  test("carries the labels on the arrows, not only on the boxes", () => {
    const svg = flowChartSvg(post);

    expect(svg).toContain("blocked");
    expect(svg).toContain("passes");
  });

  test("colours a failure arm differently from a success", () => {
    const svg = flowChartSvg(post);

    expect(svg).toContain("#3d2626");
    expect(svg).toContain("#1f3a2e");
  });

  test("drops an edge naming a node that is not there", () => {
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

describe("a flow that does not fit the old limits", () => {
  const longFlow = (count: number) => {
    const nodes = Array.from({ length: count }, (_, index) => ({
      id: `n${index}`,
      label: `Stage ${index} dedup claim on the thread so a lead never processes twice`,
    }));
    return {
      edges: nodes.slice(0, -1).map((node, index) => ({
        from: node.id,
        to: `n${index + 1}`,
      })),
      nodes,
      title: "Inbound lead flow",
    };
  };

  test("every node is drawn, past the old cap of fourteen", () => {
    const svg = flowChartSvg(longFlow(18));

    expect(svg).toContain("Stage 17");
    expect(svg).toContain("Stage 14");
  });

  test("a long label wraps instead of ending in an ellipsis", () => {
    const svg = flowChartSvg(longFlow(3));

    expect(svg).not.toContain("…");
    expect(svg).toContain("processes twice");
  });

  test("a label too long even for a full-width box wraps rather than clips", () => {
    const svg = flowChartSvg({
      edges: [],
      nodes: [
        {
          id: "solo",
          label:
            "Stage 2.5 runs the research pipeline: CRM audit, segment classification, spend signal, and enrichment, then scores the lead before anything is drafted",
        },
      ],
      title: "t",
    });

    expect((svg.match(/<text/gu) ?? []).length).toBeGreaterThan(2);
    expect(svg).not.toContain("…");
  });

  test("the canvas reaches below the lowest box", () => {
    const svg = flowChartSvg(longFlow(12));

    const canvas = Number(/height="(\d+)"/u.exec(svg)?.[1] ?? 0);
    const lowest = Math.max(
      ...[
        ...svg.matchAll(/<rect[^>]*y="([\d.]+)"[^>]*height="([\d.]+)"/gu),
      ].map((match) => Number(match[1]) + Number(match[2]))
    );

    expect(lowest).toBeLessThanOrEqual(canvas);
  });

  test("a node alone on a row uses the width it actually has", () => {
    const wide = flowChartSvg({
      edges: [],
      nodes: [{ id: "solo", label: "A label of forty-eight characters or so, kept whole" }],
      title: "t",
    });

    expect(wide).toContain("A label of forty-eight characters");
    expect(wide).not.toContain("…");
  });
});
