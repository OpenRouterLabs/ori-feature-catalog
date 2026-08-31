import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { barChartSvg } from "./charts.ts";
import { flowChartSvg } from "./flow.ts";

const rows = [
  {
    label: "conflicts",
    value: 20,
  },
  {
    label: "red CI",
    value: 9,
  },
  {
    label: "ready",
    value: 5,
  },
];

describe("barChartSvg", () => {
  test("produces an SVG carrying every row and its number", () => {
    const svg = barChartSvg({
      rows,
      title: "PR queue",
    });

    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("PR queue");
    for (const row of rows) {
      expect(svg).toContain(row.label);
      expect(svg).toContain(String(row.value));
    }
  });

  test("scales bars to the largest value, not a fixed axis", () => {
    const svg = barChartSvg({
      rows,
      title: "PR queue",
    });
    const widths = [
      ...svg.matchAll(/<rect class="bar"[^>]*width="([\d.]+)"/gu),
    ].map((match) => Number(match[1]));

    expect(widths).toHaveLength(3);
    expect(widths[0]).toBeGreaterThan(widths[1] ?? 0);
    expect(widths[1]).toBeGreaterThan(widths[2] ?? 0);
  });

  test("a label cannot close a tag it sits inside", () => {
    const svg = barChartSvg({
      rows: [
        {
          label: "</text><script>alert(1)</script>",
          value: 1,
        },
      ],
      title: "x",
    });

    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;");
  });

  test("survives a row set that would divide by zero", () => {
    const svg = barChartSvg({
      rows: [
        {
          label: "none",
          value: 0,
        },
      ],
      title: "empty",
    });

    expect(svg).toContain("<rect");
    expect(svg).not.toContain("NaN");
  });

  test("drops a value that is not a number rather than drawing NaN", () => {
    const svg = barChartSvg({
      rows: [
        ...rows,
        {
          label: "bad",
          value: Number.NaN,
        },
      ],
      title: "PR queue",
    });

    expect(svg).not.toContain("NaN");
  });

  test("caps a label long enough to run off the image", () => {
    const svg = barChartSvg({
      rows: [
        {
          label: "x".repeat(200),
          value: 1,
        },
      ],
      title: "y".repeat(200),
    });

    expect(svg).toContain("…");
  });
});

describe("a chart owns its own background", () => {
  test.each([
    [
      "bars",
      barChartSvg({
        rows: [
          {
            label: "a",
            value: 1,
          },
        ],
        title: "t",
      }),
    ],
    [
      "flow",
      flowChartSvg({
        edges: [
          {
            from: "a",
            to: "b",
          },
        ],
        nodes: [
          {
            id: "a",
            label: "a",
          },
          {
            id: "b",
            label: "b",
          },
        ],
        title: "t",
      }),
    ],
  ])("%s draws an opaque card before anything else", (_kind, svg) => {
    const firstRect = svg.indexOf("<rect");
    const firstText = svg.indexOf("<text");

    expect(svg).toContain('fill="#1a1d21"');
    expect(firstRect).toBeLessThan(firstText);
  });
});

describe("magnitude reads before the numbers do", () => {
  test("the biggest bar gets the brightest fill", () => {
    const svg = barChartSvg({
      rows: [
        {
          label: "small",
          value: 2,
        },
        {
          label: "biggest",
          value: 40,
        },
      ],
      title: "t",
    });
    const fills = [
      ...svg.matchAll(/<rect class="bar"[^>]*fill="([^"]+)"/gu),
    ].map((match) => match[1]);

    expect(fills[1]).toBe("#5eb0ff");
    expect(fills[0]).not.toBe(fills[1]);
  });
});
