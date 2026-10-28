import type { Database } from "bun:sqlite";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  listApps,
  openGhAppRegistryDb,
  registerApp,
} from "@ori-monorepo/working-with-github/gh-app-registry.ts";

import { runRegisterCli } from "./register-gh-app.ts";

const ENV = {
  TEAM_GH_APP_ID: "222",
  TEAM_GH_APP_PRIVATE_KEY: "cGVt",
} as const;

/**
 * The `list` path judged its argv against the REGISTER path's flag set
 * (KNOWN_FLAGS), so every register-only flag parsed clean there and its
 * value token followed it past the positional guard (the token after a
 * KNOWN flag is that flag's slot): `list --org acme` and
 * `list --purpose reviewer` both listed with exit 0 while the caller
 * believed a filter ran — the silent-swallow class #273/#277 closed for
 * the junk and positional shapes. `list` takes NO flag: this pins the
 * list path's own (empty) flag set on both guards.
 */
describe("register-gh-app list judges argv against the list path's own flags", () => {
  let db: Database;

  beforeEach(() => {
    db = openGhAppRegistryDb(":memory:");
    registerApp(db, {
      appIdKey: "TEAM_GH_APP_ID",
      org: "acme-list",
      privateKeyKey: "TEAM_GH_APP_PRIVATE_KEY",
      purpose: "default",
    });
  });

  afterEach(() => {
    db.close();
  });

  const probe = (argv: readonly string[]): { code: number; err: string; out: string } => {
    const err: string[] = [];
    const out: string[] = [];
    const code = runRegisterCli({
      argv,
      db,
      env: ENV,
      writers: {
        err: (t) => {
          err.push(t);
        },
        out: (t) => {
          out.push(t);
        },
      },
    });
    return { code, err: err.join(""), out: out.join("") };
  };

  test("list refuses a register-only flag, never swallows it as a filter", () => {
    const result = probe(["list", "--org", "acme-list"]);
    expect(result.code).toBe(1);
    expect(result.out).toBeEmpty();
    expect(result.err).toContain("--org");
  });

  test("list refuses --purpose the same way", () => {
    const result = probe(["list", "--purpose", "reviewer"]);
    expect(result.code).toBe(1);
    expect(result.out).toBeEmpty();
    expect(result.err).toContain("--purpose");
  });

  test("list refuses the credential-key flags too", () => {
    expect(probe(["list", "--app-id-key", "TEAM_GH_APP_ID"]).code).toBe(1);
    expect(probe(["list", "--private-key-key", "TEAM_GH_APP_PRIVATE_KEY"]).code).toBe(1);
  });

  test("the bare list invocation stays byte-identical", () => {
    const result = probe(["list"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("acme-list (default) → TEAM_GH_APP_ID / TEAM_GH_APP_PRIVATE_KEY");
    expect(listApps(db)).toHaveLength(1);
  });

  test("the register path still accepts every register flag", () => {
    const result = probe([
      "register",
      "--org",
      "acme-list",
      "--purpose",
      "reviewer",
      "--app-id-key",
      "TEAM_GH_APP_ID",
      "--private-key-key",
      "TEAM_GH_APP_PRIVATE_KEY",
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("registered acme-list (reviewer)");
  });
});
