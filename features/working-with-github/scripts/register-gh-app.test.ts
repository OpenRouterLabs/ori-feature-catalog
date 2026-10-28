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

describe("register-gh-app CLI", () => {
  let db: Database;

  beforeEach(() => {
    db = openGhAppRegistryDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("register persists the (org, purpose, key-names) row", () => {
    const { out, err, writers } = makeWriters();
    const code = runRegisterCli({
      argv: [
        "register",
        "--org",
        "acme-corp",
        "--purpose",
        "reviewer",
        "--app-id-key",
        "TEAM_GH_APP_ID",
        "--private-key-key",
        "TEAM_GH_APP_PRIVATE_KEY",
      ],
      db,
      env: ENV,
      writers,
    });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.join("")).toContain("acme-corp (reviewer)");
    expect(listApps(db)).toEqual([
      expect.objectContaining({
        appIdKey: "TEAM_GH_APP_ID",
        org: "acme-corp",
        privateKeyKey: "TEAM_GH_APP_PRIVATE_KEY",
        purpose: "reviewer",
      }),
    ]);
  });

  test("--purpose defaults to 'default'", () => {
    const { writers } = makeWriters();
    const code = runRegisterCli({
      argv: [
        "register",
        "--org",
        "acme-corp",
        "--app-id-key",
        "TEAM_GH_APP_ID",
        "--private-key-key",
        "TEAM_GH_APP_PRIVATE_KEY",
      ],
      db,
      env: ENV,
      writers,
    });
    expect(code).toBe(0);
    expect(listApps(db)[0]?.purpose).toBe("default");
  });

  test("the register confirmation echoes the normalized org, not the raw --org spelling", () => {
    // Pre-fix: `--org https://github.com/acme-corp/widgets.git` printed
    // `registered https://github.com/acme-corp/widgets.git (default) → …`
    // while `registerApp` persisted the row under `orgOf(org)` =
    // `acme-corp`. The success line named a key the registry never held, so
    // the row a later `mint-token.ts --repo acme-corp/widgets` routed to did
    // not match what the operator was told they had registered.
    const { out, writers } = makeWriters();
    const code = runRegisterCli({
      argv: [
        "register",
        "--org",
        "https://github.com/acme-corp/widgets.git",
        "--app-id-key",
        "TEAM_GH_APP_ID",
        "--private-key-key",
        "TEAM_GH_APP_PRIVATE_KEY",
      ],
      db,
      env: ENV,
      writers,
    });
    expect(code).toBe(0);
    const line = out.join("");
    expect(line).toContain("registered acme-corp (default)");
    expect(line).not.toContain("https://github.com/acme-corp/widgets.git");
    expect(listApps(db)).toEqual([
      expect.objectContaining({
        org: "acme-corp",
        purpose: "default",
      }),
    ]);
  });

  test("an empty (or whitespace) --purpose is coerced to 'default', not persisted as ''", () => {
    const { writers } = makeWriters();
    const code = runRegisterCli({
      argv: [
        "register",
        "--org",
        "acme-corp",
        "--purpose",
        "  ",
        "--app-id-key",
        "TEAM_GH_APP_ID",
        "--private-key-key",
        "TEAM_GH_APP_PRIVATE_KEY",
      ],
      db,
      env: ENV,
      writers,
    });
    expect(code).toBe(0);
    expect(listApps(db)[0]?.purpose).toBe("default");
  });

  test("refuses to persist when a named env var is absent — and never prints the values", () => {
    const { out, err, writers } = makeWriters();
    const code = runRegisterCli({
      argv: [
        "register",
        "--org",
        "acme-corp",
        "--app-id-key",
        "TEAM_GH_APP_ID",
        "--private-key-key",
        "NOT_SET_KEY",
      ],
      db,
      env: ENV,
      writers,
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("NOT_SET_KEY");
    // Nothing persisted, and no secret value leaked to either channel.
    expect(listApps(db)).toEqual([]);
    expect((out.join("") + err.join("")).includes("222")).toBe(false);
    expect((out.join("") + err.join("")).includes("cGVt")).toBe(false);
  });

  test("register requires --org, --app-id-key, and --private-key-key", () => {
    const { err, writers } = makeWriters();
    const code = runRegisterCli({
      argv: ["register", "--org", "acme-corp"],
      db,
      env: ENV,
      writers,
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("requires");
    expect(listApps(db)).toEqual([]);
  });

  test("a flag whose value was omitted is treated as absent, not the next flag", () => {
    const { err, writers } = makeWriters();
    // `--org --app-id-key X` must NOT register `--app-id-key` as the org.
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
    // The improved diagnosis names the flag whose value was omitted, never
    // the generic "requires" line that blames flags the argv carried with
    // values (the #207 "name the actual cause" class).
    expect(err.join("")).toContain("--org needs a value");
    expect(listApps(db)).toEqual([]);
  });

  test("list prints registered rows (names only); empty note when none", () => {
    const empty = makeWriters();
    expect(
      runRegisterCli({
        argv: ["list"],
        db,
        env: ENV,
        writers: empty.writers,
      })
    ).toBe(0);
    expect(empty.out.join("")).toContain("no registered apps");

    runRegisterCli({
      argv: [
        "register",
        "--org",
        "OrgA",
        "--app-id-key",
        "TEAM_GH_APP_ID",
        "--private-key-key",
        "TEAM_GH_APP_PRIVATE_KEY",
      ],
      db,
      env: ENV,
      writers: makeWriters().writers,
    });
    const listed = makeWriters();
    expect(
      runRegisterCli({
        argv: ["list"],
        db,
        env: ENV,
        writers: listed.writers,
      })
    ).toBe(0);
    expect(listed.out.join("")).toContain(
      "OrgA (default) → TEAM_GH_APP_ID / TEAM_GH_APP_PRIVATE_KEY"
    );
  });

  test("an unknown subcommand exits non-zero", () => {
    const { err, writers } = makeWriters();
    expect(
      runRegisterCli({
        argv: ["frobnicate"],
        db,
        env: ENV,
        writers,
      })
    ).toBe(1);
    expect(err.join("")).toContain("subcommand");
  });

  test("trims flag values so a stray-whitespace --org/--purpose still matches minting", () => {
    const { writers } = makeWriters();
    const code = runRegisterCli({
      argv: [
        "register",
        "--org",
        " acme-corp ",
        "--purpose",
        " reviewer ",
        "--app-id-key",
        "TEAM_GH_APP_ID",
        "--private-key-key",
        "TEAM_GH_APP_PRIVATE_KEY",
      ],
      db,
      env: ENV,
      writers,
    });
    expect(code).toBe(0);
    const [row] = listApps(db);
    expect(row?.org).toBe("acme-corp");
    expect(row?.purpose).toBe("reviewer");
  });

  test("a --purpose whose value slot was eaten by the next flag fails loudly, never persists the catch-all row", () => {
    // Pre-fix: `--purpose --app-id-key X` read the FLAG as the value via
    // readFlag (→ undefined → "default"), so the CLI silently registered the
    // org-level CATCH-ALL row — overwriting any existing (org, default)
    // mapping and routing every future mint without --purpose to that App.
    // The same class as mint-token.ts #98/#107: the caller asked for a role
    // App and silently got the default row instead.
    const { err, writers } = makeWriters();
    const code = runRegisterCli({
      argv: [
        "register",
        "--org",
        "acme-corp",
        "--purpose",
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
    expect(listApps(db)).toEqual([]);
    expect(err.join("")).toContain("--purpose");
  });

  test("a DB failure is rendered as a diagnostic + non-zero exit, not a crash", () => {
    const { err, writers } = makeWriters();
    // Closing the DB makes the subsequent registerApp throw.
    db.close();
    const code = runRegisterCli({
      argv: [
        "register",
        "--org",
        "OrgA",
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
    expect(err.join("")).toContain("failed to write registry");
    // Reopen so afterEach's close() doesn't double-close.
    db = openGhAppRegistryDb(":memory:");
  });

  test("an --org that normalizes to no org fails loudly, never persists the dead row", () => {
    // `orgOf("/")` collapses to "" (also "//", "/.git", ".git"): pre-fix the
    // row was persisted under the empty string with a blank confirmation
    // (`registered  (reviewer) → K / P`) — a registry key no mint can ever
    // derive, so the registered App was silently never used. The same
    // silent-dead-row class #101/#140 closed for URL-shaped spellings.
    for (const org of ["/", "//", "/.git", ".git"]) {
      const { out, err, writers } = makeWriters();
      const code = runRegisterCli({
        argv: [
          "register",
          "--org",
          org,
          "--purpose",
          "reviewer",
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
      expect(out).toEqual([]);
      expect(err.join("")).toContain("--org");
      expect(err.join("")).toContain("resolves to no GitHub org");
    }
    // Nothing was written for any of the junk spellings.
    expect(listApps(db)).toEqual([]);
  });
});
