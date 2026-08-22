import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { barChartSvg } from "./charts.ts";
import { svgToPng } from "./rasterise.ts";

/**
 * The bundle's `svgToPng`, narrowed rather than asserted.
 *
 * The bundled module is imported by path, so its namespace is untyped; a guard
 * states what the test calls instead of casting the shape into existence.
 */
const isRenderer = (value: unknown): value is typeof svgToPng =>
  typeof value === "function";

const readSvgToPng = (namespace: unknown): typeof svgToPng => {
  if (typeof namespace !== "object" || namespace === null) {
    throw new TypeError("the bundled module produced no namespace");
  }
  const exported: unknown = Reflect.get(namespace, "svgToPng");
  if (!isRenderer(exported)) {
    throw new TypeError("the bundled module exported no svgToPng");
  }
  return exported;
};

describe("svgToPng", () => {
  test("produces a real PNG, which is what Slack will preview", async () => {
    // Slack renders no preview for an uploaded SVG — the thread shows an empty
    // box. This is the whole reason the dependency is here.
    const blob = await svgToPng(
      barChartSvg({
        rows: [
          {
            label: "a",
            value: 3,
          },
        ],
        title: "t",
      })
    );
    const png = await blob.bytes();

    expect(png.length).toBeGreaterThan(0);
    // PNG magic: \x89 P N G
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
    expect(png[2]).toBe(0x4e);
    expect(png[3]).toBe(0x47);
  });

  test("actually draws the text, not just the boxes", async () => {
    // The bug this guards: with no font resolved, resvg renders every <text>
    // as zero glyphs and still returns a valid PNG. Every assertion about
    // magic bytes and length passed while the chart was blank, so the only
    // check worth having is that the labels change the pixels.
    const withText = await svgToPng(
      barChartSvg({
        rows: [
          {
            label: "runtime",
            value: 86_000,
          },
        ],
        title: "ori lines of code",
      })
    );
    const withoutText = await svgToPng(
      barChartSvg({
        rows: [
          {
            label: "",
            value: 86_000,
          },
        ],
        title: "",
      })
    );

    expect(withText.size).toBeGreaterThan(withoutText.size);
  });

  test("renders every chart kind the route can build", async () => {
    const blob = await svgToPng(
      barChartSvg({
        rows: [
          {
            label: "conflicts",
            value: 20,
          },
          {
            label: "ready",
            value: 5,
          },
        ],
        title: "PR queue",
      })
    );
    const png = await blob.bytes();

    expect(png.length).toBeGreaterThan(100);
  });

  /**
   * The bug this guards took every chart in the product down, and no test in
   * this file could see it: run unbundled, `import("@resvg/resvg-js")` resolves
   * against the real `node_modules` and passes. The daemon does not load this
   * source directly — it bundles the feature into a scoped temp dir, and a
   * literal specifier makes the bundler copy the `.node` binary in beside the
   * output and rewrite the require to point at that copy. The temp dir is
   * released once the module graph is imported, which is before any chart is
   * ever drawn, so the lazy require lands on a deleted path and every chart
   * fails with "cannot open shared object file".
   *
   * So this test reproduces the daemon's loading strategy rather than trusting
   * the direct import: bundle, DELETE the output directory, and only then draw.
   * A build-time-resolved binary cannot survive that; a runtime-resolved one is
   * unaffected. Without the delete the test passes either way and guards
   * nothing.
   */
  test("renders after the bundle's temp output directory is gone", async () => {
    const here = dirname(import.meta.path);
    // Inside the workspace so the bundle resolves the same packages the daemon
    // does, and hidden from the test runner so it is never collected as a test.
    const outDir = await mkdtemp(
      join(here, "..", "..", "..", "rasterise-bundle-")
    );

    try {
      const built = await Bun.build({
        entrypoints: [join(here, "rasterise.ts")],
        naming: "module.mjs",
        outdir: outDir,
        target: "bun",
        throw: false,
      });
      expect(built.success).toBe(true);

      const namespace: unknown = await import(join(outDir, "module.mjs"));
      const render = readSvgToPng(namespace);

      // The renderer has NOT been touched yet — exactly the daemon's position
      // when it drops the temp dir after loading the feature.
      await rm(outDir, {
        force: true,
        recursive: true,
      });

      const png = await render(
        barChartSvg({
          rows: [
            {
              label: "a",
              value: 1,
            },
          ],
          title: "t",
        })
      ).then(async (blob) => await blob.bytes());

      expect(png[0]).toBe(0x89);
      expect(png.length).toBeGreaterThan(100);
    } finally {
      await rm(outDir, {
        force: true,
        recursive: true,
      });
    }
  });
});
