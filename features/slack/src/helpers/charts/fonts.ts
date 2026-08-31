import { Effect, Schema } from "effect";

export class ChartFontScanError extends Schema.TaggedErrorClass<ChartFontScanError>()(
  "ChartFontScanError",
  {
    dir: Schema.String,
    cause: Schema.Defect(),
  }
) {
  override get message(): string {
    return `could not list the fonts in ${this.dir}`;
  }
}

export const FONT_DIR_CANDIDATES = [
  "/usr/share/fonts",
  "/usr/local/share/fonts",
  "/usr/share/X11/fonts",
  "/System/Library/Fonts",
  "/Library/Fonts",
] as const;

const PREFERRED_FAMILIES: ReadonlySet<string> = new Set([
  "DejaVu Sans Mono",
  "Liberation Mono",
  "Noto Sans Mono",
  "Menlo",
  "DejaVu Sans",
  "Liberation Sans",
  "Noto Sans",
  "Helvetica",
  "Arial",
]);

const MAX_FONTS_SCANNED = 200;

const FONT_EXTENSIONS = [".ttf", ".otf", ".ttc"] as const;

const OFFSET_NUM_TABLES = 4;
const TABLE_RECORDS_START = 12;
const TABLE_RECORD_SIZE = 16;
const TABLE_RECORD_TAG_SIZE = 4;
const TABLE_RECORD_OFFSET = 8;

const NAME_COUNT_OFFSET = 2;
const NAME_STRING_OFFSET = 4;
const NAME_RECORDS_START = 6;
const NAME_RECORD_SIZE = 12;
const NAME_RECORD_ID_OFFSET = 6;
const NAME_RECORD_LENGTH_OFFSET = 8;
const NAME_RECORD_STRING_OFFSET = 10;

const NAME_ID_FAMILY = 1;

const PLATFORM_UNICODE = 0;
const PLATFORM_WINDOWS = 3;

export interface ChartFontOptions {
  readonly defaultFontFamily: string;
  readonly fontDirs: readonly string[];
  readonly monospaceFamily: string;
  readonly sansSerifFamily: string;
  readonly serifFamily: string;
}

const decodeName = (bytes: Uint8Array, platformId: number): string =>
  platformId === PLATFORM_WINDOWS || platformId === PLATFORM_UNICODE
    ? new TextDecoder("utf-16be").decode(bytes)
    : new TextDecoder("latin1").decode(bytes);

const findTableOffset = (
  view: DataView,
  bytes: Uint8Array,
  tag: string
): number | undefined => {
  const numTables = view.getUint16(OFFSET_NUM_TABLES);
  for (let index = 0; index < numTables; index += 1) {
    const record = TABLE_RECORDS_START + index * TABLE_RECORD_SIZE;
    const candidate = new TextDecoder("latin1").decode(
      bytes.subarray(record, record + TABLE_RECORD_TAG_SIZE)
    );
    if (candidate === tag) {
      return view.getUint32(record + TABLE_RECORD_OFFSET);
    }
  }
  return undefined;
};

export const familyNameFrom = (bytes: Uint8Array): string | undefined => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameTable = findTableOffset(view, bytes, "name");
  if (nameTable === undefined) {
    return undefined;
  }

  const count = view.getUint16(nameTable + NAME_COUNT_OFFSET);
  const storage = nameTable + view.getUint16(nameTable + NAME_STRING_OFFSET);

  for (let index = 0; index < count; index += 1) {
    const record = nameTable + NAME_RECORDS_START + index * NAME_RECORD_SIZE;
    if (view.getUint16(record + NAME_RECORD_ID_OFFSET) !== NAME_ID_FAMILY) {
      continue;
    }
    const length = view.getUint16(record + NAME_RECORD_LENGTH_OFFSET);
    const offset = view.getUint16(record + NAME_RECORD_STRING_OFFSET);
    const name = decodeName(
      bytes.subarray(storage + offset, storage + offset + length),
      view.getUint16(record)
    ).trim();
    if (name !== "") {
      return name;
    }
  }
  return undefined;
};

const isFontFile = (path: string): boolean =>
  FONT_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension));

const familyOf = Effect.fn("Slack.charts.familyOf")(function* (
  readFont: (path: string) => Promise<Uint8Array>,
  path: string
): Effect.fn.Return<string | undefined> {
  return yield* Effect.tryPromise(
    async () => familyNameFrom(await readFont(path))
  ).pipe(Effect.orElseSucceed(() => undefined));
});

export const discoverChartFonts = Effect.fn("Slack.charts.discoverFonts")(
  function* (deps: {
    readonly listFontFiles: (dir: string) => Promise<readonly string[]>;
    readonly readFont: (path: string) => Promise<Uint8Array>;
  }): Effect.fn.Return<ChartFontOptions | undefined, ChartFontScanError> {
    const dirs: string[] = [];
    let fallback: string | undefined;
    let preferred: string | undefined;
    let scanned = 0;

    for (const dir of FONT_DIR_CANDIDATES) {
      const files = yield* Effect.tryPromise({
        try: async () => await deps.listFontFiles(dir),
        catch: (cause) =>
          new ChartFontScanError({
            cause,
            dir,
          }),
      });
      const fonts = files.filter(isFontFile);
      if (fonts.length === 0) {
        continue;
      }
      dirs.push(dir);
      for (const font of fonts) {
        if (preferred !== undefined || scanned >= MAX_FONTS_SCANNED) {
          break;
        }
        scanned += 1;
        const family = yield* familyOf(deps.readFont, font);
        if (family === undefined) {
          continue;
        }
        fallback ??= family;
        if (PREFERRED_FAMILIES.has(family)) {
          preferred = family;
        }
      }
    }

    const family = preferred ?? fallback;
    if (family === undefined) {
      return undefined;
    }
    return {
      defaultFontFamily: family,
      fontDirs: dirs,
      monospaceFamily: family,
      sansSerifFamily: family,
      serifFamily: family,
    };
  }
);
