import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

test("memory imports resolve without package import aliases in the compiled runtime", () => {
  const root = new URL("./", import.meta.url);
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
    (file) => file.endsWith(".ts") && !file.includes("node_modules")
  );
  const aliased = files.filter((file) =>
    /from ["']#/u.test(readFileSync(new URL(file, root), "utf8"))
  );
  expect(aliased).toEqual([]);
});
