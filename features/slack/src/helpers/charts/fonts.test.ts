import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { Effect } from "effect";

import { discoverChartFonts, familyNameFrom } from "./fonts.ts";

/** A minimal sfnt with one `name` table carrying family name ID 1. */
const fontWithFamily = (family: string): Uint8Array => {
  const name = new TextEncoder().encode(family);
  const nameTable = 12 + 16;
  const storage = 6 + 12;
  const bytes = new Uint8Array(nameTable + storage + name.length);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, 0x00_01_00_00);
  view.setUint16(4, 1);
  bytes.set(new TextEncoder().encode("name"), 12);
  view.setUint32(12 + 8, nameTable);

  view.setUint16(nameTable + 2, 1);
  view.setUint16(nameTable + 4, storage);
  // Platform 1 (Mac) so the string is single-byte, keeping the fixture legible.
  view.setUint16(nameTable + 6, 1);
  view.setUint16(nameTable + 6 + 6, 1);
  view.setUint16(nameTable + 6 + 8, name.length);
  view.setUint16(nameTable + 6 + 10, 0);
  bytes.set(name, nameTable + storage);

  return bytes;
};

describe("familyNameFrom", () => {
  test("reads the family name out of the name table", () => {
    expect(familyNameFrom(fontWithFamily("Lato"))).toBe("Lato");
  });

  test("returns undefined for bytes that are not a font", () => {
    expect(familyNameFrom(new Uint8Array(64))).toBeUndefined();
  });
});

describe("discoverChartFonts", () => {
  test.effect("points every family slot at the font it found", () =>
    Effect.gen(function* () {
      // The chart SVGs ask for font-family="monospace". resvg only resolves that
      // generic if it was told which real family backs it, so a discovered font
      // that is not wired into monospaceFamily still renders nothing.
      const options = yield* discoverChartFonts({
        listFontFiles: (dir) =>
          Promise.resolve(
            dir === "/usr/share/fonts" ? ["/usr/share/fonts/lato/Lato.ttf"] : []
          ),
        readFont: () => Promise.resolve(fontWithFamily("Lato")),
      });

      expect(options).toBeDefined();
      expect(options?.monospaceFamily).toBe("Lato");
      expect(options?.defaultFontFamily).toBe("Lato");
      expect(options?.fontDirs).toEqual(["/usr/share/fonts"]);
    })
  );

  test.effect("ignores non-font files in a font directory", () =>
    Effect.gen(function* () {
      const options = yield* discoverChartFonts({
        listFontFiles: (dir) =>
          Promise.resolve(
            dir === "/usr/share/fonts" ? ["/usr/share/fonts/README.txt"] : []
          ),
        readFont: () =>
          Promise.reject(new Error("a .txt must never be parsed as a font")),
      });

      expect(options).toBeUndefined();
    })
  );

  test.effect("reports no font rather than pretending, when the box has none", () =>
    Effect.gen(function* () {
      // This is the VM the bug appeared on: font files present, no fontconfig,
      // so resvg's own system lookup finds nothing and draws zero glyphs.
      const options = yield* discoverChartFonts({
        listFontFiles: () => Promise.resolve([]),
        readFont: () => Promise.resolve(new Uint8Array()),
      });

      expect(options).toBeUndefined();
    })
  );

  test.effect("collects every directory that holds fonts", () =>
    Effect.gen(function* () {
      const options = yield* discoverChartFonts({
        listFontFiles: (dir) =>
          Promise.resolve(
            dir === "/usr/share/fonts" || dir === "/usr/local/share/fonts"
              ? [`${dir}/Lato.ttf`]
              : []
          ),
        readFont: () => Promise.resolve(fontWithFamily("Lato")),
      });

      expect(options?.fontDirs).toEqual([
        "/usr/share/fonts",
        "/usr/local/share/fonts",
      ]);
    })
  );

  test.effect("one unreadable file does not lose the fonts beside it", () =>
    Effect.gen(function* () {
      const options = yield* discoverChartFonts({
        listFontFiles: (dir) =>
          Promise.resolve(
            dir === "/usr/share/fonts"
              ? ["/usr/share/fonts/broken.ttf", "/usr/share/fonts/Lato.ttf"]
              : []
          ),
        readFont: (path) =>
          path.endsWith("broken.ttf")
            ? Promise.reject(new Error("EACCES: permission denied"))
            : Promise.resolve(fontWithFamily("Lato")),
      });

      expect(options?.defaultFontFamily).toBe("Lato");
    })
  );

  test.effect("a font whose name table is malformed is skipped, not fatal", () =>
    Effect.gen(function* () {
      const options = yield* discoverChartFonts({
        listFontFiles: (dir) =>
          Promise.resolve(
            dir === "/usr/share/fonts"
              ? ["/usr/share/fonts/truncated.ttf", "/usr/share/fonts/Lato.ttf"]
              : []
          ),
        readFont: (path) =>
          Promise.resolve(
            path.endsWith("truncated.ttf")
              ? fontWithFamily("Lato").subarray(0, 20)
              : fontWithFamily("Lato")
          ),
      });

      expect(options?.defaultFontFamily).toBe("Lato");
    })
  );

  test.effect("prefers a font that can draw Latin over whichever sorted first", () =>
    Effect.gen(function* () {
      const options = yield* discoverChartFonts({
        listFontFiles: (dir) =>
          Promise.resolve(
            dir === "/usr/share/fonts"
              ? ["/usr/share/fonts/Symbol.ttf", "/usr/share/fonts/DejaVuSans.ttf"]
              : []
          ),
        readFont: (path) =>
          Promise.resolve(
            fontWithFamily(path.endsWith("Symbol.ttf") ? "Symbol" : "DejaVu Sans")
          ),
      });

      expect(options?.defaultFontFamily).toBe("DejaVu Sans");
    })
  );

  test.effect("falls back to any font when none of the preferred ones are there", () =>
    Effect.gen(function* () {
      const options = yield* discoverChartFonts({
        listFontFiles: (dir) =>
          Promise.resolve(dir === "/usr/share/fonts" ? ["/f/Comic.ttf"] : []),
        readFont: () => Promise.resolve(fontWithFamily("Comic Sans MS")),
      });

      expect(options?.defaultFontFamily).toBe("Comic Sans MS");
    })
  );
});
