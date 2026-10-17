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

  test("falls back to the repo segment of GITHUB_REPO", () => {
    expect(
      resolveConfigDirName({ GITHUB_REPO: "acme-interns/helper-bot" })
    ).toBe("helper-bot");
  });

  test("falls back to 'intern' when nothing is set", () => {
    expect(resolveConfigDirName({})).toBe("intern");
  });
});
