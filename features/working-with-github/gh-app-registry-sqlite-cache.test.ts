import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sqliteInstallationCache } from "./gh-app-registry.ts";

const restoreEnv = (key: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
};

describe("sqliteInstallationCache", () => {
  let home = "";
  let previousHome: string | undefined;
  let previousInternName: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "wwg-cache-"));
    process.env.HOME = home;
    previousInternName = process.env.INTERN_NAME;
    process.env.INTERN_NAME = home.split("/").at(-1);
  });

  afterEach(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("INTERN_NAME", previousInternName);
    rmSync(home, { force: true, recursive: true });
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
