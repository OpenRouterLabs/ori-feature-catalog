import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

const SRC = dirname(fileURLToPath(import.meta.url));

const tsFilesUnder = (dir: string, found: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      tsFilesUnder(child, found);
    } else if (entry.name.endsWith(".ts")) {
      found.push(child);
    }
  }
  return found;
};

/**
 * Directories whose index is the only way in. A directory joins this list when
 * its index becomes a curated contract rather than a re-export of everything,
 * and when nothing it depends on is also a door -- two directories that
 * aggregate and reference each other form an import cycle.
 */
const DOORS = ["thread"];

describe("a directory index is the way in", () => {
  for (const directory of DOORS.map((name) => join(SRC, name))) {
    const name = relative(SRC, directory);
    // Test scaffolding is not part of the contract: a sibling's test may reach
    // for it directly, and routing it through the door would publish it.
    const inside = new Set(
      readdirSync(directory)
        .filter(
          (entry) =>
            entry.endsWith(".ts") &&
            entry !== "index.ts" &&
            !entry.includes("test-support") &&
            !entry.includes(".test.")
        )
        .map((entry) => entry.replace(/\.ts$/u, ""))
    );

    test(`nothing outside ${name} reaches past its index`, () => {
      const reached: string[] = [];
      for (const file of tsFilesUnder(SRC)) {
        if (file.startsWith(`${directory}/`)) {
          continue;
        }
        for (const match of readFileSync(file, "utf8").matchAll(
          /from "[^"]*\/([\w-]+)\/([\w-]+)\.ts"/gu
        )) {
          if (match[1] === name.split("/").at(-1) && inside.has(match[2] ?? "")) {
            reached.push(`${relative(SRC, file)} -> ${match[2] ?? ""}`);
          }
        }
      }
      expect(reached).toEqual([]);
    });
  }
});
