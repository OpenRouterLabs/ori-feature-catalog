import type { Database } from "bun:sqlite";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  listApps,
  openGhAppRegistryDb,
} from "@ori-monorepo/working-with-github/gh-app-registry.ts";

import { runRegisterCli } from "./register-gh-app.ts";

// `--app-id-key` / `--private-key-key` take env var NAMES. The easy mistake
// is passing the VALUE — `--private-key-key "$TEAM_GH_APP_PRIVATE_KEY"`
// expands to the base64 key itself. No env var has that name, so register
// refuses it, but pre-fix the refusal echoed the argument whole:
//
//   register-gh-app: named env var(s) not set: LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVkt…
//
// printing the private key (or a ghp_ token) into stderr, the logs, and any
// chat the agent relays the error to.

const PEM_B64 = Buffer.from(
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecret\n-----END RSA PRIVATE KEY-----\n"
).toString("base64");
const GHP_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

const run = (db: Database, argv: readonly string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = runRegisterCli({
    argv,
    db,
    env: { TEAM_GH_APP_ID: "222", TEAM_GH_APP_PRIVATE_KEY: PEM_B64 },
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

describe("register-gh-app never echoes a secret passed where a key NAME belongs", () => {
  let db: Database;

  beforeEach(() => {
    db = openGhAppRegistryDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("the private key's value in --private-key-key is withheld", () => {
    const result = run(db, [
      "register",
      "--org",
      "acme",
      "--app-id-key",
      "TEAM_GH_APP_ID",
      "--private-key-key",
      PEM_B64,
    ]);
    expect(result.code).toBe(1);
    expect(result.err).not.toContain(PEM_B64);
    expect(result.err).not.toContain(PEM_B64.slice(0, 16));
    expect(result.err).toContain(
      `${PEM_B64.length}-character --private-key-key value`
    );
    expect(result.err).toContain("never its value");
    expect(listApps(db)).toEqual([]);
  });

  test("a token in --app-id-key is withheld, a real unset name beside it is still named", () => {
    const result = run(db, [
      "register",
      "--org",
      "acme",
      "--app-id-key",
      GHP_TOKEN,
      "--private-key-key",
      "TEAM_GH_APP_PRIVATE_KEY_TYPO",
    ]);
    expect(result.code).toBe(1);
    expect(result.err).not.toContain(GHP_TOKEN);
    expect(result.err).not.toContain("ghp_");
    expect(result.err).toContain(`${GHP_TOKEN.length}-character --app-id-key value`);
    expect(result.err).toContain("TEAM_GH_APP_PRIVATE_KEY_TYPO");
  });

  test("an unset conventional name is still echoed, so a typo stays easy to spot", () => {
    const result = run(db, [
      "register",
      "--org",
      "acme",
      "--app-id-key",
      "TEAM_GH_APPID",
      "--private-key-key",
      "TEAM_GH_APP_PRIVATE_KEY",
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      "register-gh-app: named env var(s) not set: TEAM_GH_APPID\n"
    );
  });

  test("set names still register and confirm as before", () => {
    const result = run(db, [
      "register",
      "--org",
      "acme",
      "--app-id-key",
      "TEAM_GH_APP_ID",
      "--private-key-key",
      "TEAM_GH_APP_PRIVATE_KEY",
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      "registered acme (default) → TEAM_GH_APP_ID / TEAM_GH_APP_PRIVATE_KEY\n"
    );
  });
});
