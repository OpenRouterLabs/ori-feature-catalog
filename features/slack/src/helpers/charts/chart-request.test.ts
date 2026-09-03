import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { makeChartPipeline } from "./index.ts";

const charts = makeChartPipeline();

const base = {
  channel: "C1",
  thread_ts: "1700.1",
  title: "PR queue",
};

describe("the chart pipeline parse", () => {
  test("renders bars from rows", () => {
    const parsed = charts.parse({
      ...base,
      kind: "bars",
      rows: [
        {
          label: "conflicts",
          value: 20,
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.request.svg).toContain("conflicts");
  });

  test("refuses a kind with nothing to draw", () => {
    expect(
      charts.parse({
        ...base,
        kind: "bars",
        rows: [],
      }).ok
    ).toBe(false);
    expect(
      charts.parse({
        ...base,
        kind: "flow",
      }).ok
    ).toBe(false);
  });

  test("refuses a shape it cannot read rather than guessing", () => {
    expect(
      charts.parse({
        ...base,
        kind: "pie",
      }).ok
    ).toBe(false);
    expect(charts.parse(null).ok).toBe(false);
  });

  test("caps a row set nobody could read in a thread", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      label: `row-${i}`,
      value: i,
    }));
    const parsed = charts.parse({
      ...base,
      kind: "bars",
      rows,
    });

    expect(parsed.ok && parsed.request.svg).not.toContain("row-100");
  });
});

describe("tables are not drawn", () => {
  test("the chart request rejects the table kind", () => {
    const parsed = charts.parse({
      channel: "C1",
      cells: [["a", "b"]],
      headers: ["x", "y"],
      kind: "table",
      thread_ts: "1700.1",
      title: "sizes",
    });

    expect(parsed.ok).toBe(false);
  });

  test("a shape is still drawn", () => {
    const parsed = charts.parse({
      channel: "C1",
      graph: "flowchart TD\n  A --> B",
      kind: "flow",
      thread_ts: "1700.1",
      title: "the path",
    });

    expect(parsed.ok).toBe(true);
  });
});

const fanOut = (children: number): string =>
  [
    "flowchart TD",
    ...Array.from(
      { length: children },
      (_, index) => `  A(Surfaces) --> S${index}[Surface ${index}]`
    ),
  ].join("\n");

const flowBody = (graph: string): Record<string, string> => ({
  channel: "C1",
  graph,
  kind: "flow",
  thread_ts: "1.2",
  title: "Second pass",
});

describe("a flow that would draw as a smear", () => {
  test("four siblings still render", () => {
    expect(charts.parse(flowBody(fanOut(4))).ok).toBe(true);
  });

  test("nine are refused, and the reason names the table", () => {
    const parsed = charts.parse(flowBody(fanOut(9)));

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain("markdown table");
  });

  test("a line break tag never reaches a label", () => {
    const parsed = charts.parse(
      flowBody(
        "flowchart TD\n  A(Untrusted surfaces<br/>and where they land) --> B[Next]"
      )
    );

    expect(parsed.ok).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain("<br");
  });
});

describe("a flow with more nodes than fit", () => {
  const nodesOf = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `n${index}`,
      label: `Stage ${index}`,
    }));

  const chainOf = (count: number) =>
    Array.from({ length: count - 1 }, (_, index) => ({
      from: `n${index}`,
      to: `n${index + 1}`,
    }));

  test("is refused rather than quietly losing its tail", () => {
    const parsed = charts.parse({
      channel: "C1",
      edges: chainOf(40),
      kind: "flow",
      nodes: nodesOf(40),
      thread_ts: "1700.1",
      title: "too long",
    });

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain("split it into two charts");
  });

  test("a flow at the cap still renders", () => {
    const parsed = charts.parse({
      channel: "C1",
      edges: chainOf(30),
      kind: "flow",
      nodes: nodesOf(30),
      thread_ts: "1700.1",
      title: "at the cap",
    });

    expect(parsed.ok).toBe(true);
  });
});

