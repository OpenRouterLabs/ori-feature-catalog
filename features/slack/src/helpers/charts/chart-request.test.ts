import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { parseChartBody } from "./chart-request.ts";

const base = {
  channel: "C1",
  thread_ts: "1700.1",
  title: "PR queue",
};

describe("parseChartBody", () => {
  test("renders bars from rows", () => {
    const parsed = parseChartBody({
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
    // A chart of no rows is a blank image and a wasted upload.
    expect(
      parseChartBody({
        ...base,
        kind: "bars",
        rows: [],
      }).ok
    ).toBe(false);
    expect(
      parseChartBody({
        ...base,
        kind: "flow",
      }).ok
    ).toBe(false);
  });

  test("refuses a shape it cannot read rather than guessing", () => {
    expect(
      parseChartBody({
        ...base,
        kind: "pie",
      }).ok
    ).toBe(false);
    expect(parseChartBody(null).ok).toBe(false);
  });

  test("caps a row set nobody could read in a thread", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      label: `row-${i}`,
      value: i,
    }));
    const parsed = parseChartBody({
      ...base,
      kind: "bars",
      rows,
    });

    expect(parsed.ok && parsed.request.svg).not.toContain("row-100");
  });
});

describe("tables are not drawn", () => {
  test("the chart request rejects the table kind", () => {
    // Slack renders GitHub-flavoured tables natively now. Drawn as an image
    // they came out as overlapping text nobody could read, next to a native
    // table in the same reply that rendered perfectly.
    const parsed = parseChartBody({
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
    const parsed = parseChartBody({
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
    expect(parseChartBody(flowBody(fanOut(4))).ok).toBe(true);
  });

  test("nine are refused, and the reason names the table", () => {
    // The chart that started this: nine checked surfaces fanned from one node,
    // whose labels overlapped into "ack HMACaulttunnel proxykey-proxy allows".
    const parsed = parseChartBody(flowBody(fanOut(9)));

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain("markdown table");
  });

  test("a line break tag never reaches a label", () => {
    // Labels are escaped for the SVG, so `<br/>` rendered as those four
    // characters inside the box.
    const parsed = parseChartBody(
      flowBody(
        "flowchart TD\n  A(Untrusted surfaces<br/>and where they land) --> B[Next]"
      )
    );

    expect(parsed.ok).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain("<br");
  });
});
