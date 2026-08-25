/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * rasterise.ts — SVG in, PNG out.
 *
 * Slack renders no preview for an uploaded SVG: the file arrives and the thread
 * shows an empty box. So the helpers build SVG — pure strings, testable without
 * a renderer — and this converts before upload.
 *
 * The renderer is imported LAZILY, and that is load-bearing. It is a native
 * module with per-platform binaries, and a static import puts it in the chain
 * `index.ts -> turn-routes.ts -> chart-route.ts -> here`. A binary that fails
 * to load then takes the whole chat surface down at import time — the entire
 * Slack integration dead because a chart renderer could not start.
 *
 * Loaded on first chart instead: a missing binary costs charts and nothing
 * else, and the failure names itself rather than surfacing as "chat surface
 * failed" on boot.
 */

// Type-only, so it is erased at build and never becomes a resolvable
// specifier that would pull the native binary into the bundle (see
// RESVG_SPECIFIER). It also keeps the dependency visible to the unused-
// dependency check, which cannot see through the runtime import below.
import type { Resvg } from "@resvg/resvg-js";

import { Effect, Schema } from "effect";

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { ChartFontOptions } from "./fonts.ts";

import { discoverChartFonts, FONT_DIR_CANDIDATES } from "./fonts.ts";

/** Wide enough to stay legible in a thread without being a wall. */
const RENDER_WIDTH = 1440;

/** A directory with no fonts — or no directory — is a skip, not a failure. */
const listFontFiles = async (dir: string): Promise<readonly string[]> => {
  try {
    // The walk and the mapping both sit inside the `try`. An unreadable
    // directory has to stay a skip, and a throw out of either one is the same
    // answer: this directory contributes no fonts.
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

/** Named so the autofixer cannot strip a bare `undefined` and widen this. */
const NO_FONTS: ChartFontOptions | undefined = undefined;

/**
 * The walk, with every way it can end badly already turned into "no font".
 *
 * The recovery matters as much as the memo below: a memo cell that recorded a
 * failure never expires, so a walk that failed once would fail every chart
 * until a restart. It is recovered to the same `undefined` a fontless box
 * produces — the caller cannot draw either way, and says so — and it is
 * recovered HERE, before the memo can see it, which is what keeps a failure
 * out of the cell rather than trusting the cell not to keep one.
 *
 * `catchCause` rather than `catch`, because the old shape recovered a
 * rejection and a defect reaches this point the same way a rejection did.
 * `uninterruptible` for the same reason in the other direction: an interrupt
 * landing mid-walk would be recorded in the cell and replayed at every later
 * chart, and the walk it guards is bounded by `MAX_FONTS_SCANNED`.
 */
const discoverFontsOnce = discoverChartFonts({
  listFontFiles,
  readFont,
}).pipe(
  Effect.catchCause(() => Effect.succeed(NO_FONTS)),
  Effect.uninterruptible
);

/**
 * Font discovery is a filesystem walk, so it is done once per process.
 *
 * `undefined` (no font on the box) is cached as deliberately as a hit — it is
 * a property of the machine, and re-walking every directory on every chart to
 * rediscover the same absence is pure cost.
 */
let fontsMemo: Effect.Effect<ChartFontOptions | undefined> | undefined;

const chartFonts = Effect.fn("Slack.charts.fonts")(
  function* (): Effect.fn.Return<ChartFontOptions | undefined> {
    // `Effect.cached` builds the cell, and the cell dedupes concurrent callers
    // on a latch — two charts drawn at once still walk the filesystem once.
    const memo = (fontsMemo ??= yield* Effect.cached(discoverFontsOnce));
    return yield* memo;
  }
);

/** A thrown non-Error still has to produce a sentence the caller can read. */
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** No font on this box, so every label would be drawn as zero glyphs. */
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

/** The renderer would not load: a broken binding, not a bad chart. */
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

/** The renderer refused THIS SVG. The only failure the spec can fix. */
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

/** Everything `svgToPng` can refuse, as one channel a caller can match on. */
export type ChartRenderFailure =
  | ChartRasteriseError
  | ChartRendererUnavailableError
  | NoChartFontError;

/** The real constructor's type, taken from the package's own declarations. */
type ResvgConstructor = typeof Resvg;

/**
 * A predicate rather than a cast: the native binding is untyped at this point,
 * and a guard states the shape being relied on instead of asserting past it.
 */
const isResvgConstructor = (value: unknown): value is ResvgConstructor =>
  typeof value === "function";

/**
 * One property off a value of unknown type, without asserting past the check.
 *
 * A dynamic `import()` whose specifier is not a literal is typed `any`, so the
 * namespace is taken as `unknown` and read through here — narrowing from
 * `unknown` states the shape being relied on rather than trusting it.
 */
const readProperty = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

/**
 * The renderer's package name, assembled so the bundler cannot read it.
 *
 * This indirection is the fix for a bug that took charts down entirely, and it
 * has to stay. A literal `import("@resvg/resvg-js")` is a specifier the
 * bundler resolves at build time: it follows the CJS module to its `.node`
 * binary, copies that binary into the build's output directory under a
 * content-hashed name, and rewrites the require to point at the copy.
 *
 * That output directory is a SCOPED TEMP DIR (`ori-fresh-*`), released as soon
 * as the feature's module graph has been imported. Because this module loads
 * the renderer lazily — deliberately, so a broken binary costs charts and not
 * the whole chat surface — the require does not run until the first chart,
 * which is always AFTER that temp dir has been deleted. The rewritten path
 * then points at nothing and every chart fails with "cannot open shared object
 * file", while the real binary sits untouched in `node_modules`. Lazy loading
 * and build-time asset copying are individually correct and together fatal.
 *
 * A specifier the bundler cannot constant-fold is left as a runtime import, so
 * resolution happens against the live `node_modules` rather than a temp copy
 * that no longer exists. Do not inline this back into the `import()`.
 */
const RESVG_SPECIFIER = ["@resvg", "resvg-js"].join("/");

const NO_CONSTRUCTOR =
  "@resvg/resvg-js exported no Resvg constructor — the native binding did not load";

/**
 * The renderer's constructor, whichever shape the import gives back.
 *
 * `@resvg/resvg-js` is CommonJS. Depending on who is doing the loading, the
 * namespace of a CJS module either carries interop-hoisted named exports or
 * only puts them on `default` — and under the bundled runtime that loads this
 * feature it is the latter, so the obvious destructure lands `undefined` and
 * fails at `new` with "undefined is not a constructor". Both shapes are
 * checked so the same source works in a test, a script, and the daemon.
 */
const loadResvg = Effect.fn("Slack.charts.loadResvg")(
  function* (): Effect.fn.Return<
    ResvgConstructor,
    ChartRendererUnavailableError
  > {
    // The import and both reads stay inside the thunk: a binding that blows up
    // on load throws from `import()`, and outside a `tryPromise` that would be
    // a defect no caller could turn into an answer.
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

/**
 * SVG in, PNG out — or a typed failure naming what stopped it.
 *
 * Its three refusals are separate tags rather than one flattened sentence: no
 * font on this box, a binding that never loaded, and a spec this renderer
 * would not draw are three different things to do something about, and only
 * the last is the caller's fault. `chart-route.ts` still answers all three
 * with the same 422, and now it does so by matching a channel rather than by
 * catching whatever was thrown.
 */
export const svgToPng = Effect.fn("Slack.charts.svgToPng")(function* (
  svg: string
): Effect.fn.Return<Blob, ChartRenderFailure> {
  const fonts = yield* chartFonts();
  if (fonts === undefined) {
    return yield* Effect.fail(new NoChartFontError());
  }

  const Resvg = yield* loadResvg();

  return yield* Effect.try({
    // Render and copy together inside the thunk: an SVG the renderer refuses
    // throws from `render()`, and that has to stay a failure the route can
    // report rather than a defect that ends the request.
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

      // A copy into a plain ArrayBuffer: the renderer hands back a Node
      // Buffer, which is not the BlobPart the upload path is typed against.
      return new Blob([new Uint8Array(png).buffer]);
    },
    catch: (cause) =>
      new ChartRasteriseError({
        cause,
        reason: describeError(cause),
      }),
  });
});
