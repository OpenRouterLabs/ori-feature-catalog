import { describe, expect, test } from "#src/test-support/effect-test.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Effect } from "effect";

import { barChartSvg } from "./charts.ts";
import { svgToPng } from "./rasterise.ts";

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
  test.effect("produces a real PNG, which is what Slack will preview", () =>
    Effect.gen(function* () {
      const blob = yield* svgToPng(
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
      const png = yield* Effect.promise(() => blob.bytes());

      expect(png.length).toBeGreaterThan(0);
      expect(png[0]).toBe(0x89);
      expect(png[1]).toBe(0x50);
      expect(png[2]).toBe(0x4e);
      expect(png[3]).toBe(0x47);
    })
  );

  test.effect("actually draws the text, not just the boxes", () =>
    Effect.gen(function* () {
      const withText = yield* svgToPng(
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
      const withoutText = yield* svgToPng(
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
    })
  );

  test.effect("renders every chart kind the route can build", () =>
    Effect.gen(function* () {
      const blob = yield* svgToPng(
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
      const png = yield* Effect.promise(() => blob.bytes());

      expect(png.length).toBeGreaterThan(100);
    })
  );

  test.effect("renders after the bundle's temp output directory is gone", () =>
    Effect.gen(function* () {
      const here = dirname(import.meta.path);
      const outDir = yield* Effect.acquireRelease(
        Effect.promise(() =>
          mkdtemp(join(here, "..", "..", "..", "node_modules", ".rasterise-bundle-"))
        ),
        (dir) =>
          Effect.promise(() =>
            rm(dir, {
              force: true,
              recursive: true,
            })
          )
      );

      const built = yield* Effect.promise(() =>
        Bun.build({
          entrypoints: [join(here, "rasterise.ts")],
          naming: "module.mjs",
          outdir: outDir,
          target: "bun",
          throw: false,
        })
      );
      expect(built.success).toBe(true);

      const namespace: unknown = yield* Effect.promise(
        () => import(join(outDir, "module.mjs"))
      );
      const render = readSvgToPng(namespace);

      yield* Effect.promise(() =>
        rm(outDir, {
          force: true,
          recursive: true,
        })
      );

      const blob = yield* render(
        barChartSvg({
          rows: [
            {
              label: "a",
              value: 1,
            },
          ],
          title: "t",
        })
      );
      const png = yield* Effect.promise(() => blob.bytes());

      expect(png[0]).toBe(0x89);
      expect(png.length).toBeGreaterThan(100);
    })
  );
});
