/**
 * fonts.ts — find a font the renderer can actually draw with.
 *
 * resvg does not ship a font. It defaults to `loadSystemFonts: true`, which
 * asks fontconfig for the system list — and this VM has font FILES but no
 * fontconfig, so that lookup returns nothing. resvg then renders every
 * `<text>` as zero glyphs and still succeeds: a valid PNG of the boxes with
 * every label invisible. A silent blank chart, not an error.
 *
 * So the font directories are passed explicitly instead of being discovered,
 * and the family name is read out of the font file rather than guessed. The
 * chart SVGs ask for `font-family="monospace"`, a generic that only resolves
 * if resvg was told which real family backs it — hence every family slot is
 * pointed at the family we actually found.
 */

/** Where a Linux/macOS box keeps fonts. Missing entries are skipped. */
export const FONT_DIR_CANDIDATES = [
  "/usr/share/fonts",
  "/usr/local/share/fonts",
  "/usr/share/X11/fonts",
  "/System/Library/Fonts",
  "/Library/Fonts",
] as const;

/** Best first. "First file found" lands on Symbol, which draws no Latin. */
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

/** A box with more fonts than this does not need all of them read. */
const MAX_FONTS_SCANNED = 200;

const FONT_EXTENSIONS = [".ttf", ".otf", ".ttc"] as const;

/** sfnt table directory: numTables at 4, records from 12, 16 bytes each. */
const OFFSET_NUM_TABLES = 4;
const TABLE_RECORDS_START = 12;
const TABLE_RECORD_SIZE = 16;
const TABLE_RECORD_TAG_SIZE = 4;
const TABLE_RECORD_OFFSET = 8;

/** `name` table: count at 2, string storage offset at 4, records from 6. */
const NAME_COUNT_OFFSET = 2;
const NAME_STRING_OFFSET = 4;
const NAME_RECORDS_START = 6;
const NAME_RECORD_SIZE = 12;
const NAME_RECORD_ID_OFFSET = 6;
const NAME_RECORD_LENGTH_OFFSET = 8;
const NAME_RECORD_STRING_OFFSET = 10;

/** Name ID 1 is the font family. */
const NAME_ID_FAMILY = 1;

/** Platform IDs whose strings are UTF-16BE rather than single-byte. */
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

/**
 * The family name from a font file's `name` table.
 *
 * Parsed here rather than pulled from a font-parsing dependency: this reads
 * two tables to get one string, and the alternative is a package in the chat
 * surface's dependency chain for it.
 */
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

/**
 * One font's family, or `undefined` for anything unreadable.
 *
 * Unguarded, one bad file rejected the whole walk — and discovery is memoised,
 * so it then failed every chart until a restart.
 */
const familyOf = async (
  readFont: (path: string) => Promise<Uint8Array>,
  path: string
): Promise<string | undefined> => {
  try {
    return familyNameFrom(await readFont(path));
  } catch {
    return undefined;
  }
};

/**
 * Font options for resvg, or undefined when the box has no font at all.
 *
 * Undefined is a real outcome, not an error: charts are unreadable without a
 * font, and a caller that knows that can say so instead of uploading a PNG of
 * empty boxes.
 */
export const discoverChartFonts = async (deps: {
  readonly listFontFiles: (dir: string) => Promise<readonly string[]>;
  readonly readFont: (path: string) => Promise<Uint8Array>;
}): Promise<ChartFontOptions | undefined> => {
  const dirs: string[] = [];
  let fallback: string | undefined;
  let preferred: string | undefined;
  let scanned = 0;

  for (const dir of FONT_DIR_CANDIDATES) {
    const files = await deps.listFontFiles(dir);
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
      const family = await familyOf(deps.readFont, font);
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
};
