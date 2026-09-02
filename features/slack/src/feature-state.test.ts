import { existsSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import type * as FeatureStateModule from "./feature-state.ts";

import { featureState } from "./feature-state.ts";

const nearestNodeModules = (): string => {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(directory, "node_modules");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("no node_modules above the test file");
    }
    directory = parent;
  }
};

const freshBuild = async (): Promise<typeof FeatureStateModule> => {
  // Build into the nearest node_modules, the way ori's own loader does in
  // `freshOutputBaseDirectory`. `packages: "external"` leaves imports like
  // `effect` in the output, so they only resolve from inside the workspace.
  const outdir = mkdtempSync(join(nearestNodeModules(), "ori-feature-state-"));
  const built = await Bun.build({
    entrypoints: [
      fileURLToPath(new URL("./feature-state.ts", import.meta.url)),
    ],
    naming: "module.mjs",
    outdir,
    packages: "external",
    target: "bun",
    throw: false,
  });
  expect(built.success).toBe(true);
  return import(
    pathToFileURL(join(outdir, "module.mjs")).href
  ) as Promise<typeof FeatureStateModule>;
};

describe("featureState", () => {
  test("hands every caller in one load the same object", () => {
    expect(featureState()).toBe(featureState());
  });

  test("survives independent builds of the module", async () => {
    const first = await freshBuild();
    const second = await freshBuild();

    expect(first).not.toBe(second);

    first.featureState().buttons.set("built-by-the-first", () => {});

    expect(second.featureState().buttons.has("built-by-the-first")).toBe(true);

    second.featureState().buttons.delete("built-by-the-first");
  });
});
