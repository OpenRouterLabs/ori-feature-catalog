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

import { Effect } from "effect";

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { ChartFontOptions } from "./fonts.ts";

import { discoverChartFonts, FONT_DIR_CANDIDATES } from "./fonts.ts";

/** Wide enough to stay legible in a thread without being a wall. */
const RENDER_WIDTH = 1440;

/** A directory with no fonts — or no directory — is a skip, not a failure. */
const listFontFiles = async (dir: string): Promise<readonly string[]> =>
  await Effect.runPromise(
    // The walk and the mapping both sit inside the `tryPromise`. A throw out
    // of an `Effect.map` would be a defect, which `orElseSucceed` does not
    // recover — and an unreadable directory has to stay a skip.
    Effect.tryPromise(async () =>
      (
        await readdir(dir, {
          recursive: true,
          withFileTypes: true,
        })
      )
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name))
    ).pipe(Effect.orElseSucceed((): readonly string[] => []))
  );

const readFont = async (path: string): Promise<Uint8Array> =>
  new Uint8Array(await Bun.file(path).arrayBuffer());

/**
 * Font discovery is a filesystem walk, so it is done once per process.
 *
 * `undefined` (no font on the box) is cached as deliberately as a hit — it is
 * a property of the machine, and re-walking every directory on every chart to
 * rediscover the same absence is pure cost.
 */
let fontsPromise: Promise<ChartFontOptions | undefined> | undefined;

/** Named so the autofixer cannot strip a bare `undefined` and widen this. */
const NO_FONTS: ChartFontOptions | undefined = undefined;

const chartFonts = async (): Promise<ChartFontOptions | undefined> => {
  fontsPromise ??= Effect.runPromise(
    // The recovery matters as much as the memo: a cached rejection never
    // expires, so a walk that failed once would fail every chart until a
    // restart. Recovered to the same `undefined` a fontless box produces —
    // the caller cannot draw either way, and says so.
    Effect.tryPromise(async () =>
      discoverChartFonts({
        listFontFiles,
        readFont,
      })
    ).pipe(Effect.orElseSucceed(() => NO_FONTS))
  );
  return await fontsPromise;
};

export class NoChartFontError extends Error {
  constructor() {
    super(
      "no font available to render chart text — every label would be invisible. " +
        `Looked in ${FONT_DIR_CANDIDATES.join(", ")}; install any TTF/OTF into one of them.`
    );
    this.name = "NoChartFontError";
  }
}

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
const loadResvg = async (): Promise<ResvgConstructor> => {
  const namespace: unknown = await import(RESVG_SPECIFIER);
  const constructor =
    readProperty(namespace, "Resvg") ??
    readProperty(readProperty(namespace, "default"), "Resvg");
  if (!isResvgConstructor(constructor)) {
    throw new TypeError(
      "@resvg/resvg-js exported no Resvg constructor — the native binding did not load"
    );
  }
  return constructor;
};

/**
 * SVG in, PNG out — or a rejection naming what stopped it.
 *
 * Its two refusals — no font on the box, and a binding that exported no
 * constructor — stay throws rather than typed failures because the only
 * caller already treats them as one outcome: `chart-route.ts` renders through
 * a two-argument `.then`, turning any rejection into the 422 sentence the
 * skill reads back. A typed channel here would be spelled out only to be
 * flattened into `describeError` there.
 */
export const svgToPng = async (svg: string): Promise<Blob> => {
  const fonts = await chartFonts();
  if (fonts === undefined) {
    throw new NoChartFontError();
  }

  const Resvg = await loadResvg();
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

  // A copy into a plain ArrayBuffer: the renderer hands back a Node Buffer,
  // which is not the BlobPart the upload path is typed against.
  return new Blob([new Uint8Array(png).buffer]);
};
