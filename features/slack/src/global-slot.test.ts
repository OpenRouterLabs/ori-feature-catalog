import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { globalSlot } from "./global-slot.ts";

describe("globalSlot", () => {
  test("reads back what was installed and clears on uninstall", () => {
    const slot = globalSlot<string>("ori.slack.test.readback");

    const uninstall = slot.install("first");
    expect(slot.read()).toBe("first");

    uninstall();
    expect(slot.read()).toBeUndefined();
  });

  test("a stale uninstall leaves a newer value installed", () => {
    const slot = globalSlot<string>("ori.slack.test.stale");

    const staleUninstall = slot.install("stale");
    const freshUninstall = slot.install("fresh");

    staleUninstall();
    expect(slot.read()).toBe("fresh");

    freshUninstall();
  });

  test("a value crosses independent builds of the module", async () => {
    const freshBuild = async (): Promise<typeof import("./global-slot.ts")> => {
      const outdir = mkdtempSync(join(tmpdir(), "ori-slot-test-"));
      const built = await Bun.build({
        entrypoints: [fileURLToPath(new URL("./global-slot.ts", import.meta.url))],
        naming: "module.mjs",
        outdir,
        packages: "external",
        target: "bun",
        throw: false,
      });
      expect(built.success).toBe(true);
      return import(pathToFileURL(join(outdir, "module.mjs")).href) as Promise<
        typeof import("./global-slot.ts")
      >;
    };

    const first = await freshBuild();
    const second = await freshBuild();

    expect(first).not.toBe(second);

    const written = first.globalSlot<string>("ori.slack.test.rebuilt");
    const read = second.globalSlot<string>("ori.slack.test.rebuilt");

    const uninstall = written.install("set by the first build");

    expect(read.read()).toBe("set by the first build");

    uninstall();
  });
});
