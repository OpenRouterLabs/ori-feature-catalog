import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

const SRC = dirname(fileURLToPath(import.meta.url));

const indexesUnder = (dir: string, found: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const child = join(dir, entry.name);
    if (readdirSync(child).includes("index.ts")) {
      found.push(join(child, "index.ts"));
    }
    indexesUnder(child, found);
  }
  return found;
};

const isPureReExport = (file: string): boolean => {
  const source = readFileSync(file, "utf8")
    .replaceAll(/\/\*[\S\s]*?\*\//gu, "")
    .replaceAll(/^\s*\/\/.*$/gmu, "");
  const statements = source
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  return (
    statements.length > 0 &&
    statements.every((statement) => /^export\b[\S\s]* from "[^"]+"$/u.test(statement))
  );
};

describe("an index is an entry point", () => {
  test("no directory index is only re-exports", () => {
    const barrels = indexesUnder(SRC)
      .filter(isPureReExport)
      .map((file) => relative(SRC, dirname(file)));

    expect(barrels).toEqual([]);
  });
});
