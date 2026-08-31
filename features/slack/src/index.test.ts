import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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

const indexes = indexesUnder(SRC);

describe("every directory index", () => {
  test("one exists for each directory", () => {
    const directories = indexesUnder(SRC).map((file) => dirname(file));
    const missing: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const child = join(dir, entry.name);
        if (!directories.includes(child)) {
          missing.push(relative(SRC, child));
        }
        visit(child);
      }
    };
    visit(SRC);
    expect(missing).toEqual([]);
  });

  for (const file of indexes) {
    const name = relative(SRC, dirname(file));
    test(`${name} links and re-exports live names`, async () => {
      const loaded = (await import(file)) as Record<string, unknown>;
      const names = Object.keys(loaded).filter((key) => key !== "default");
      expect(names.length).toBeGreaterThan(0);
      for (const exported of names) {
        expect(loaded[exported]).toBeDefined();
      }
    });
  }
});
