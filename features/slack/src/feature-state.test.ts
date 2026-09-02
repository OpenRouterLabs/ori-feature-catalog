import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import type * as FeatureStateModule from "./feature-state.ts";

import { featureState } from "./feature-state.ts";

const freshBuild = async (): Promise<typeof FeatureStateModule> => {
  const outdir = mkdtempSync(join(tmpdir(), "ori-feature-state-"));
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
