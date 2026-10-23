import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PURPOSE,
  lookupApp,
  openGhAppRegistryDb,
  orgOf,
  registerApp,
} from "./gh-app-registry.ts";
import type { GhAppKeyNames } from "./gh-app-registry.ts";

// The register CLI accepts (and the feature prompt documents) the same
// spellings for `--org` that `mint-token.ts --repo` accepts. Every sibling
// resolver tolerates a URL spelling for a REPO (github.com[:/]owner/repo),
// but `--org` carries an ORG, not a repo — and the org never has the second
// path segment the repo regexes require. Persisting it raw keys the row under
// a string the mint path (orgOf(targetRepo) — a REPO string) can never
// produce, so every later mint silently falls back to the default App —
// the #101 class, reopened through the org side.

describe("registerApp → lookupApp round-trip on the mint key", () => {
  const roundtrip = (org: string): GhAppKeyNames | null => {
    const db = openGhAppRegistryDb(":memory:");
    registerApp(db, {
      appIdKey: "TEAM_GH_APP_ID",
      org,
      privateKeyKey: "TEAM_GH_APP_PRIVATE_KEY",
      purpose: DEFAULT_PURPOSE,
    });
    // The mint path derives its lookup key from a REPO string via orgOf.
    return lookupApp(db, orgOf("acme-corp/widgets"), DEFAULT_PURPOSE);
  };

  test("a bare org register resolves at mint time", () => {
    const row = roundtrip("acme-corp");
    expect(row).not.toBeNull();
    expect(row?.appIdKey).toBe("TEAM_GH_APP_ID");
  });

  test("a full https repo URL passed to --org still resolves at mint time", () => {
    // The prompt documents --org tolerating repo spellings; the row must key
    // under the same org a repo-string mint derives.
    const row = roundtrip("https://github.com/acme-corp/widgets.git");
    expect(row).not.toBeNull();
    expect(row?.appIdKey).toBe("TEAM_GH_APP_ID");
  });

  test("an ssh-form repo URL passed to --org still resolves at mint time", () => {
    const row = roundtrip("git@github.com:acme-corp/widgets.git");
    expect(row).not.toBeNull();
    expect(row?.appIdKey).toBe("TEAM_GH_APP_ID");
  });

  test("an org-URL (no repo segment) passed to --org resolves at mint time", () => {
    // A copy-pasted org page URL — the natural operator spelling:
    // https://github.com/acme-corp → the org IS acme-corp.
    const row = roundtrip("https://github.com/acme-corp");
    expect(row?.appIdKey ?? null).toBe("TEAM_GH_APP_ID");
  });

  test("a trailing slash on an org-URL resolves at mint time", () => {
    const row = roundtrip("https://github.com/acme-corp/");
    expect(row?.appIdKey ?? null).toBe("TEAM_GH_APP_ID");
  });

  test("a bare org with a trailing slash resolves at mint time", () => {
    const row = roundtrip("acme-corp/");
    expect(row?.appIdKey ?? null).toBe("TEAM_GH_APP_ID");
  });
});