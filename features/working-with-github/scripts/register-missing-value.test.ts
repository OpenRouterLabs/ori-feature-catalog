import type { Database } from "bun:sqlite";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  listApps,
  openGhAppRegistryDb,
} from "@ori-monorepo/working-with-github/gh-app-registry.ts";

import { runRegisterCli } from "./register-gh-app.ts";

interface Captured {
  readonly out: string[];
  readonly err: string[];
  readonly writers: {
    readonly out: (t: string) => void;
    readonly err: (t: string) => void;
  };
}

const makeWriters = (): Captured => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    err,
    out,
    writers: {
      err: (t) => {
        err.push(t);
      },
      out: (t) => {
        out.push(t);
      },
    },
  };
};

const ENV = {
  TEAM_GH_APP_ID: "222",
  TEAM_GH_APP_PRIVATE_KEY: "cGVt",
} as const;

describe("register-gh-app: a present-but-valueless flag names the flag", () => {
  let db: Database;

  beforeEach(() => {
    db = openGhAppRegistryDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("an --org whose slot was eaten by the next flag names --org, not the generic requires line", () => {
    const { err, writers } = makeWriters();
    const code = runRegisterCli({
      argv: [
        "register",
        "--org",
        "--app-id-key",
        "TEAM_GH_APP_ID",
        "--private-key-key",
        "TEAM_GH_APP_PRIVATE_KEY",
      ],
      db,
      env: ENV,
      writers,
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("--org needs a value");
    // The generic line never fires: --app-id-key/--private-key-key were passed
    // with values, and blaming them for the --org omission is a lie.
    expect(err.join("")).not.toContain("requires --org, --app-id-key");
    expect(listApps(db)).toEqual([]);
  });

  test("a trailing valueless --private-key-key names that flag", () => {
    const { err, writers } = makeWriters();
    const code = runRegisterCli({
      argv: [
        "register",
        "--org",
        "acme-corp",
        "--app-id-key",
        "TEAM_GH_APP_ID",
        "--private-key-key",
      ],
      db,
      env: ENV,
      writers,
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain(
      "--private-key-key needs a value"
    );
    expect(listApps(db)).toEqual([]);
  });

  test("an --app-id-key whose slot was eaten names that flag, not --org", () => {
    const { err, writers } = makeWriters();
    const code = runRegisterCli({
      argv: [
        "register",
        "--org",
        "acme-corp",
        "--app-id-key",
        "--private-key-key",
        "TEAM_GH_APP_PRIVATE_KEY",
      ],
      db,
      env: ENV,
      writers,
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("--app-id-key needs a value");
    expect(listApps(db)).toEqual([]);
  });

  test("a genuinely absent --org keeps the generic requires line", () => {
    const { err, writers } = makeWriters();
    const code = runRegisterCli({
      argv: ["register", "--app-id-key", "TEAM_GH_APP_ID", "--private-key-key", "TEAM_GH_APP_PRIVATE_KEY"],
      db,
      env: ENV,
      writers,
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("requires --org, --app-id-key, and --private-key-key");
    expect(listApps(db)).toEqual([]);
  });

  test("a present-but-blank --org (an empty value) is the same omission shape", () => {
    const { err, writers } = makeWriters();
    const code = runRegisterCli({
      argv: ["register", "--org", "", "--app-id-key", "TEAM_GH_APP_ID", "--private-key-key", "TEAM_GH_APP_PRIVATE_KEY"],
      db,
      env: ENV,
      writers,
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("--org needs a value");
    expect(listApps(db)).toEqual([]);
  });

  test("a healthy register still lands (regression guard)", () => {
    const { out, err, writers } = makeWriters();
    const code = runRegisterCli({
      argv: ["register", "--org", "acme-corp", "--purpose", "reviewer", "--app-id-key", "TEAM_GH_APP_ID", "--private-key-key", "TEAM_GH_APP_PRIVATE_KEY"],
      db,
      env: ENV,
      writers,
    });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.join("")).toContain("registered acme-corp (reviewer)");
    expect(listApps(db).length).toBe(1);
  });
});
