import type { Database } from "bun:sqlite";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_PURPOSE,
  deleteCachedInstallation,
  getCachedInstallation,
  listApps,
  lookupApp,
  openGhAppRegistryDb,
  orgOf,
  purgeNonAllowlistedInstallations,
  putCachedInstallation,
  registerApp,
  resolveApp,
  resolveConfigDirName,
} from "./gh-app-registry.ts";

describe("gh-app-registry — register / lookup / list round-trip", () => {
  let db: Database;

  beforeEach(() => {
    db = openGhAppRegistryDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("registers and looks up an (org, purpose) → key-names row", () => {
    registerApp(db, {
      appIdKey: "TEAM_GH_APP_ID",
      org: "acme-corp",
      privateKeyKey: "TEAM_GH_APP_PRIVATE_KEY",
      purpose: "reviewer",
    });

    expect(lookupApp(db, "acme-corp", "reviewer")).toEqual({
      appIdKey: "TEAM_GH_APP_ID",
      privateKeyKey: "TEAM_GH_APP_PRIVATE_KEY",
    });
    // A different purpose in the same org is not this row.
    expect(lookupApp(db, "acme-corp", "maintainer")).toBeNull();
    // A different org is not this row.
    expect(lookupApp(db, "SomeoneElse", "reviewer")).toBeNull();
  });

  test("upserts on the composite (org, purpose) key rather than duplicating", () => {
    registerApp(db, {
      appIdKey: "OLD_ID",
      org: "acme-interns",
      privateKeyKey: "OLD_KEY",
      purpose: "reviewer",
    });
    registerApp(db, {
      appIdKey: "NEW_ID",
      org: "acme-interns",
      privateKeyKey: "NEW_KEY",
      purpose: "reviewer",
    });

    expect(lookupApp(db, "acme-interns", "reviewer")).toEqual({
      appIdKey: "NEW_ID",
      privateKeyKey: "NEW_KEY",
    });
    expect(listApps(db)).toHaveLength(1);
  });

  test("normalizes a repo-shaped org before persisting, so the mint path can look it up", () => {
    // The register CLI and the feature prompt document `--org` accepting the
    // same spellings `mint-token.ts --repo` takes (a bare owner/repo, a full
    // https URL with optional .git, an ssh/scp string). `mintInstallationToken`
    // derives its registry key via `orgOf(targetRepo)`, so a raw
    // `acme-corp/widgets` row is never matched and the mint silently falls
    // back to the default App instead of the registered one.
    for (const org of [
      "acme-corp/widgets",
      "https://github.com/acme-corp/widgets",
      "https://github.com/acme-corp/widgets.git",
      "git@github.com:acme-corp/widgets.git",
    ]) {
      registerApp(db, {
        appIdKey: "TEAM_GH_APP_ID",
        org,
        privateKeyKey: "TEAM_GH_APP_PRIVATE_KEY",
        purpose: "reviewer",
      });
      // Stored under the owner segment, not the repo-shaped raw value.
      expect(lookupApp(db, "acme-corp", "reviewer")).toEqual({
        appIdKey: "TEAM_GH_APP_ID",
        privateKeyKey: "TEAM_GH_APP_PRIVATE_KEY",
      });
      // A raw repo-shaped lookup must not match either: the mint path never
      // produces one (orgOf runs first), so the store must not keep a row
      // only a bogus lookup could hit.
      expect(lookupApp(db, org, "reviewer")).toBeNull();
      // Every spelling upserts the one row — no duplicates accumulate.
      expect(listApps(db)).toHaveLength(1);
    }
    // The exact resolver chain the mint path runs (orgOf → resolveApp with
    // the purpose, then the default fallback) hits the row end to end.
    expect(resolveApp(db, orgOf("acme-corp/widgets"), "reviewer")).toEqual({
      appIdKey: "TEAM_GH_APP_ID",
      privateKeyKey: "TEAM_GH_APP_PRIVATE_KEY",
    });
  });

  test("matches org and purpose case-insensitively (GitHub logins are)", () => {
    registerApp(db, {
      appIdKey: "TEAM_GH_APP_ID",
      org: "acme-corp",
      privateKeyKey: "TEAM_GH_APP_PRIVATE_KEY",
      purpose: "Reviewer",
    });

    // A mint against a differently-cased org/purpose must still find the row.
    expect(lookupApp(db, "acme-corp", "reviewer")).toEqual({
      appIdKey: "TEAM_GH_APP_ID",
      privateKeyKey: "TEAM_GH_APP_PRIVATE_KEY",
    });
    expect(resolveApp(db, "ACME-CORP", "REVIEWER")).toEqual({
      appIdKey: "TEAM_GH_APP_ID",
      privateKeyKey: "TEAM_GH_APP_PRIVATE_KEY",
    });
    // And re-registering with different casing upserts the same row, not a second one.
    registerApp(db, {
      appIdKey: "TEAM_GH_APP_ID",
      org: "acme-corp",
      privateKeyKey: "TEAM_GH_APP_PRIVATE_KEY",
      purpose: "reviewer",
    });
    expect(listApps(db)).toHaveLength(1);
  });

  test("listApps returns key NAMES only — never any secret value", () => {
    registerApp(db, {
      appIdKey: "A_ID",
      org: "OrgA",
      privateKeyKey: "A_KEY",
      purpose: "reviewer",
    });
    registerApp(db, {
      appIdKey: "B_ID",
      org: "OrgB",
      privateKeyKey: "B_KEY",
      purpose: DEFAULT_PURPOSE,
    });

    const rows = listApps(db);
    expect(rows).toHaveLength(2);
    // Sorted by org, then purpose.
    expect(rows.map((r) => `${r.org}/${r.purpose}`)).toEqual([
      "OrgA/reviewer",
      "OrgB/default",
    ]);
    for (const row of rows) {
      expect(row.appIdKey).toMatch(/_ID$/u);
      expect(row.privateKeyKey).toMatch(/_KEY$/u);
    }
  });
});

describe("gh-app-registry — resolveApp fallback chain", () => {
  let db: Database;

  beforeEach(() => {
    db = openGhAppRegistryDb(":memory:");
    registerApp(db, {
      appIdKey: "REVIEWER_ID",
      org: "acme-interns",
      privateKeyKey: "REVIEWER_KEY",
      purpose: "reviewer",
    });
    registerApp(db, {
      appIdKey: "ORG_DEFAULT_ID",
      org: "acme-interns",
      privateKeyKey: "ORG_DEFAULT_KEY",
      purpose: DEFAULT_PURPOSE,
    });
  });

  afterEach(() => {
    db.close();
  });

  test("returns the exact (org, purpose) row when present", () => {
    expect(resolveApp(db, "acme-interns", "reviewer")).toEqual({
      appIdKey: "REVIEWER_ID",
      privateKeyKey: "REVIEWER_KEY",
    });
  });

  test("falls back to the (org, default) row for an unregistered purpose", () => {
    expect(resolveApp(db, "acme-interns", "maintainer")).toEqual({
      appIdKey: "ORG_DEFAULT_ID",
      privateKeyKey: "ORG_DEFAULT_KEY",
    });
  });

  test("returns null (→ bare default app) for an org with no rows", () => {
    expect(resolveApp(db, "UnknownOrg", "reviewer")).toBeNull();
    expect(resolveApp(db, "UnknownOrg", DEFAULT_PURPOSE)).toBeNull();
  });

  test("returns null when only a non-default purpose exists and default is missing", () => {
    const bare = openGhAppRegistryDb(":memory:");
    registerApp(bare, {
      appIdKey: "ONLY_REVIEWER_ID",
      org: "OrgWithoutDefault",
      privateKeyKey: "ONLY_REVIEWER_KEY",
      purpose: "reviewer",
    });
    // Asking for a different purpose falls through to (org, default), which is absent → null.
    expect(resolveApp(bare, "OrgWithoutDefault", "maintainer")).toBeNull();
    bare.close();
  });
});

describe("gh-app-registry — installation-id cache", () => {
  let db: Database;

  beforeEach(() => {
    db = openGhAppRegistryDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("put / get / delete round-trip keyed by (appId, org)", () => {
    expect(
      getCachedInstallation(db, {
        appId: "111",
        org: "acme-interns",
      })
    ).toBeNull();

    putCachedInstallation(
      db,
      {
        appId: "111",
        org: "acme-interns",
      },
      "4242"
    );
    expect(
      getCachedInstallation(db, {
        appId: "111",
        org: "acme-interns",
      })
    ).toBe("4242");
    // A different app or org is a different key.
    expect(
      getCachedInstallation(db, {
        appId: "222",
        org: "acme-interns",
      })
    ).toBeNull();

    // Upsert replaces the id for the same key.
    putCachedInstallation(
      db,
      {
        appId: "111",
        org: "acme-interns",
      },
      "9999"
    );
    expect(
      getCachedInstallation(db, {
        appId: "111",
        org: "acme-interns",
      })
    ).toBe("9999");

    deleteCachedInstallation(db, {
      appId: "111",
      org: "acme-interns",
    });
    expect(
      getCachedInstallation(db, {
        appId: "111",
        org: "acme-interns",
      })
    ).toBeNull();
  });

  test("purgeNonAllowlistedInstallations drops foreign and empty-org rows, keeps allowlisted", () => {
    putCachedInstallation(db, { appId: "111", org: "acme-interns" }, "1");
    putCachedInstallation(db, { appId: "111", org: "kolfadser1" }, "2");
    putCachedInstallation(db, { appId: "111", org: "" }, "3");
    putCachedInstallation(db, { appId: "222", org: "AttackerOrg" }, "4");

    const removed = purgeNonAllowlistedInstallations(db, [
      "acme-corp",
      "acme-interns",
    ]);
    expect(removed).toBe(3);

    // Allowlisted (case-insensitively) rows survive.
    expect(
      getCachedInstallation(db, { appId: "111", org: "acme-interns" })
    ).toBe("1");
    // The empty-org row carries no owner identity, so it is dropped too.
    expect(getCachedInstallation(db, { appId: "111", org: "" })).toBeNull();
    // Foreign rows are gone.
    expect(
      getCachedInstallation(db, { appId: "111", org: "kolfadser1" })
    ).toBeNull();
    expect(
      getCachedInstallation(db, { appId: "222", org: "AttackerOrg" })
    ).toBeNull();
  });

  test("org matching is case-insensitive; empty org (sole-installation) is cacheable", () => {
    putCachedInstallation(
      db,
      {
        appId: "111",
        org: "acme-interns",
      },
      "4242"
    );
    expect(
      getCachedInstallation(db, {
        appId: "111",
        org: "acme-interns",
      })
    ).toBe("4242");

    // The default-app-with-no-derivable-org case caches under the empty string.
    putCachedInstallation(
      db,
      {
        appId: "111",
        org: "",
      },
      "500"
    );
    expect(
      getCachedInstallation(db, {
        appId: "111",
        org: "",
      })
    ).toBe("500");
  });
});

describe("orgOf", () => {
  test("extracts the org from owner/repo", () => {
    expect(orgOf("acme-corp/widgets")).toBe("acme-corp");
  });

  test("extracts the org from a full https GitHub URL and strips .git", () => {
    expect(orgOf("https://github.com/acme-corp/widgets.git")).toBe(
      "acme-corp"
    );
  });
});

describe("resolveConfigDirName", () => {
  test("prefers INTERN_NAME, sanitized", () => {
    expect(resolveConfigDirName({ INTERN_NAME: "Helper Bot" })).toBe(
      "helper-bot"
    );
  });

  test("an INTERN_NAME that sanitizes to nothing falls through, never returns the empty string", () => {
    // A punctuation-only name (`...`, `---`, `(((` — a stray paste) sanitizes to
    // "", and pre-fix the empty string was RETURNED: `join(homedir,
    // ".config", "")` is the config ROOT, so the registry DB landed at
    // `~/.config/gh-app-registry.db`, shared with every other store keyed
    // there — while the GITHUB_REPO fallthrough own empty case already
    // answers `intern`. One branch, no guard.
    expect(resolveConfigDirName({ INTERN_NAME: "..." })).toBe("intern");
    expect(resolveConfigDirName({ INTERN_NAME: "---" })).toBe("intern");
    expect(resolveConfigDirName({ INTERN_NAME: "(((" })).toBe("intern");
    // A sanitized-non-empty name keeps its exact answer.
    expect(resolveConfigDirName({ INTERN_NAME: "___" })).toBe("___");
    // With a repo also present, the fallthrough is the repo segment.
    expect(
      resolveConfigDirName({ GITHUB_REPO: "acme/widgets", INTERN_NAME: "..." })
    ).toBe("widgets");
  });

  test("falls back to the repo segment of GITHUB_REPO", () => {
    expect(
      resolveConfigDirName({ GITHUB_REPO: "acme-interns/helper-bot" })
    ).toBe("helper-bot");
  });

  test("falls back to 'intern' when nothing is set", () => {
    expect(resolveConfigDirName({})).toBe("intern");
  });
});

describe("gh-app-registry — SQLite busy contention", () => {
  test("openGhAppRegistryDb arms a busy_timeout, and a blocked writer waits instead of failing instantly", () => {
    // Two connections on one DB file, exactly what a register-gh-app CLI run
    // and a concurrent mint's installation-cache put look like. SQLite's
    // default busy_timeout is 0: with the write lock held, a second writer
    // fails IMMEDIATELY with "database is locked" — and the registry/cache
    // seams swallow that error as a no-op, so the write silently disappears.
    const path = `/tmp/wwg-busy-test-${process.pid}-${Date.now()}.db`;
    const holder = openGhAppRegistryDb(path);
    const waiter = openGhAppRegistryDb(path);
    try {
      // (1) The opener must arm a real bounded wait, not SQLite's default 0.
      const armed = waiter
        .query<{ readonly timeout: number }, []>("PRAGMA busy_timeout")
        .get();
      expect(armed?.timeout ?? 0).toBeGreaterThanOrEqual(1000);
      // (2) Behavioral: with the write lock held, a write from the second
      // connection BLOCKS for the armed timeout instead of failing instantly
      // (pre-fix: SQLITE_BUSY after ~0ms). The wait is shortened here only
      // to keep the suite fast; the opener's own value is asserted in (1).
      waiter.run("PRAGMA busy_timeout = 200");
      holder.run("BEGIN IMMEDIATE");
      const started = Date.now();
      let threw = false;
      try {
        waiter.run(
          "INSERT INTO gh_app_registry (org,purpose,app_id_key,private_key_key,registered_at) VALUES ('w','p','W_ID','W_PK',0)"
        );
      } catch {
        threw = true;
      }
      const waitedMs = Date.now() - started;
      // The lock is genuinely held for the whole window — the write cannot
      // land; what must change is that it WAITED rather than failed at once.
      expect(threw).toBeTrue();
      expect(waitedMs).toBeGreaterThanOrEqual(150);
      holder.run("ROLLBACK");
    } finally {
      holder.close();
      waiter.close();
      // Best-effort cleanup of the file and its WAL sidecars.
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          require("node:fs").unlinkSync(`${path}${suffix}`);
        } catch {
          // tmp cleans up.
        }
      }
    }
  });
});

describe("resolveConfigDirName — trailing-slash GITHUB_REPO spellings", () => {
  test("a trailing slash does not change the config dir name (bare owner/repo spelling)", () => {
    expect(resolveConfigDirName({ GITHUB_REPO: "acme/widgets/" })).toBe(
      resolveConfigDirName({ GITHUB_REPO: "acme/widgets" })
    );
    expect(resolveConfigDirName({ GITHUB_REPO: "acme/widgets" })).toBe(
      "widgets"
    );
  });

  test("a trailing slash does not change the config dir name (full URL spelling)", () => {
    expect(
      resolveConfigDirName({ GITHUB_REPO: "https://github.com/acme/widgets/" })
    ).toBe(resolveConfigDirName({ GITHUB_REPO: "acme/widgets" }));
    expect(
      resolveConfigDirName({
        GITHUB_REPO: "https://github.com/acme/widgets.git/",
      })
    ).toBe("widgets");
  });
});
