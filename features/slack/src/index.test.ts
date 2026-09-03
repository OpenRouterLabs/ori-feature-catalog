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

describe("a directory index is its layer", () => {
  for (const file of indexesUnder(SRC)) {
    const name = relative(SRC, dirname(file));
    const source = readFileSync(file, "utf8");

    test(`${name} builds a layer rather than forwarding names`, () => {
      expect(source).toMatch(/export const make\w+Layer/u);
      expect(source).not.toMatch(/^export \* from/mu);
    });
  }
});
