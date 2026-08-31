/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */

import type { Resvg } from "@resvg/resvg-js";

import { Effect, Schema } from "effect";

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { ChartFontOptions } from "./fonts.ts";

import { discoverChartFonts, FONT_DIR_CANDIDATES } from "./fonts.ts";

const RENDER_WIDTH = 1440;

const listFontFiles = async (dir: string): Promise<readonly string[]> => {
  try {
    return (
      await readdir(dir, {
        recursive: true,
        withFileTypes: true,
      })
    )
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
  } catch {
    return [];
  }
};

const readFont = async (path: string): Promise<Uint8Array> =>
  new Uint8Array(await Bun.file(path).arrayBuffer());

const NO_FONTS: ChartFontOptions | undefined = undefined;

const discoverFontsOnce = discoverChartFonts({
  listFontFiles,
  readFont,
}).pipe(
  Effect.catchCause(() => Effect.succeed(NO_FONTS)),
  Effect.uninterruptible,
  Effect.withSpan("Slack.charts.discoverFontsOnce")
);

let fontsMemo: Effect.Effect<ChartFontOptions | undefined> | undefined;

const chartFonts = Effect.fn("Slack.charts.fonts")(
  function* (): Effect.fn.Return<ChartFontOptions | undefined> {
    const memo = (fontsMemo ??= yield* Effect.cached(discoverFontsOnce));
    return yield* memo;
  }
);

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class NoChartFontError extends Schema.TaggedErrorClass<NoChartFontError>()(
  "NoChartFontError",
  {}
) {
  override get message(): string {
    return (
      "no font available to render chart text — every label would be invisible. " +
      `Looked in ${FONT_DIR_CANDIDATES.join(", ")}; install any TTF/OTF into one of them.`
    );
  }
}

export class ChartRendererUnavailableError extends Schema.TaggedErrorClass<ChartRendererUnavailableError>()(
  "ChartRendererUnavailableError",
  {
    reason: Schema.String,
    cause: Schema.Defect(),
  }
) {
  override get message(): string {
    return this.reason;
  }
}

export class ChartRasteriseError extends Schema.TaggedErrorClass<ChartRasteriseError>()(
  "ChartRasteriseError",
  {
    reason: Schema.String,
    cause: Schema.Defect(),
  }
) {
  override get message(): string {
    return this.reason;
  }
}

export type ChartRenderFailure =
  | ChartRasteriseError
  | ChartRendererUnavailableError
  | NoChartFontError;

type ResvgConstructor = typeof Resvg;

const isResvgConstructor = (value: unknown): value is ResvgConstructor =>
  typeof value === "function";

const readProperty = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

const RESVG_SPECIFIER = ["@resvg", "resvg-js"].join("/");

const NO_CONSTRUCTOR =
  "@resvg/resvg-js exported no Resvg constructor — the native binding did not load";

const loadResvg = Effect.fn("Slack.charts.loadResvg")(
  function* (): Effect.fn.Return<
    ResvgConstructor,
    ChartRendererUnavailableError
  > {
    const constructor = yield* Effect.tryPromise({
      try: async (): Promise<unknown> => {
        const namespace: unknown = await import(RESVG_SPECIFIER);
        return (
          readProperty(namespace, "Resvg") ??
          readProperty(readProperty(namespace, "default"), "Resvg")
        );
      },
      catch: (cause) =>
        new ChartRendererUnavailableError({
          cause,
          reason: describeError(cause),
        }),
    });

    if (!isResvgConstructor(constructor)) {
      return yield* Effect.fail(
        new ChartRendererUnavailableError({
          cause: undefined,
          reason: NO_CONSTRUCTOR,
        })
      );
    }
    return constructor;
  }
);

export const svgToPng = Effect.fn("Slack.charts.svgToPng")(function* (
  svg: string
): Effect.fn.Return<Blob, ChartRenderFailure> {
  const fonts = yield* chartFonts();
  if (fonts === undefined) {
    return yield* Effect.fail(new NoChartFontError());
  }

  const Resvg = yield* loadResvg();

  return yield* Effect.try({
    try: (): Blob => {
      const png = new Resvg(svg, {
        fitTo: {
          mode: "width",
          value: RENDER_WIDTH,
        },
        font: {
          defaultFontFamily: fonts.defaultFontFamily,
          fontDirs: [...fonts.fontDirs],
          monospaceFamily: fonts.monospaceFamily,
          sansSerifFamily: fonts.sansSerifFamily,
          serifFamily: fonts.serifFamily,
        },
      })
        .render()
        .asPng();

      return new Blob([new Uint8Array(png).buffer]);
    },
    catch: (cause) =>
      new ChartRasteriseError({
        cause,
        reason: describeError(cause),
      }),
  });
});
