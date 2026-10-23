import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sqliteInstallationCache } from "./gh-app-registry.ts";

describe("sqliteInstallationCache", () => {
  let dir = "";
  let previousDir: string | undefined;

  beforeEach(() => {
    // Redirect the registry DB via GH_APP_REGISTRY_DIR — the seam
    // `openGhAppRegistryDb` honors. Pre-fix, this test reassigned
    // `process.env.HOME`, but Bun's `os.homedir()` snapshots the real home at
    // process start and ignores that, so every "isolated" test DB silently
    // landed under the operator's real `~/.config/wwg-cache-*/` — a stray
    // registry per run, hundreds accumulated on this workspace's home.
    previousDir = process.env.GH_APP_REGISTRY_DIR;
    dir = mkdtempSync(join(tmpdir(), "wwg-cache-"));
    process.env.GH_APP_REGISTRY_DIR = dir;
  });

  afterEach(() => {
    if (previousDir === undefined) {
      delete process.env.GH_APP_REGISTRY_DIR;
    } else {
      process.env.GH_APP_REGISTRY_DIR = previousDir;
    }
    rmSync(dir, { force: true, recursive: true });
  });

  test("round-trips an installation id through the on-disk registry", () => {
    expect(sqliteInstallationCache.get("111", "acme-corp")).toBeNull();
    sqliteInstallationCache.put("111", "acme-corp", "42");
    expect(sqliteInstallationCache.get("111", "acme-corp")).toBe("42");
    sqliteInstallationCache.delete("111", "acme-corp");
    expect(sqliteInstallationCache.get("111", "acme-corp")).toBeNull();
  });

  test("purges installations whose owner is not allowlisted", () => {
    sqliteInstallationCache.put("111", "acme-corp", "42");
    sqliteInstallationCache.put("111", "other-org", "43");
    expect(sqliteInstallationCache.purge(["acme-corp"])).toBe(1);
    expect(sqliteInstallationCache.get("111", "acme-corp")).toBe("42");
    expect(sqliteInstallationCache.get("111", "other-org")).toBeNull();
  });
});
