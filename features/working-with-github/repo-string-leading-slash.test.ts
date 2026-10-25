import { describe, expect, test } from "bun:test";
// Regression: a LEADING slash — `/acme/widgets` (a shell-autocomplete paste
// of a repo path) — is the same repo as `acme/widgets`. Pre-fix
// `resolveRepoFromEnv` returned the raw spelling whole, so:
//
//   - every `repos/{repo}` route 404ed on the doubled slash
//     (`repos//acme/widgets`);
//   - `git worktree add` keyed the cleanup SLUG `-acme-widgets` — a slug
//     dir the daily sweep never lists;
//   - `orgOf("/acme/widgets")` returned the WHOLE string as the org (the
//     anchored two-segment match misses a leading slash), so a registry
//     row registered from it and the derived allowlist were both keyed on
//     a string no mint can derive from any real repo spelling;
//   - `resolveConfigDirName` — the only sibling that already handled it —
//     resolved `widgets`, so the config dir silently disagreed with the
//     repo routes for one spelling (the #113 class).
//
// `resolveRepoFromEnv` and `orgOf` now strip leading slashes, matching
// `resolveConfigDirName` and the prompt's `REPO=` sed (`s#^/##`).

import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";

const LEADING_SLASH_SPELLINGS: string[] = [
  "/acme/widgets",
  "//acme/widgets",
  "/acme/widgets/",
  "/acme",
];

describe("a leading-slash repo spelling resolves like its bare form", () => {
  test.each(LEADING_SLASH_SPELLINGS)(
    "resolveRepoFromEnv strips the leading slash from %s",
    (spelling: string) => {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe(
        spelling.replace(/^\/+/u, "").replace(/\/+$/u, "")
      );
    }
  );

  test("/acme/widgets resolves to the bare repo", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: "/acme/widgets" })).toBe(
      "acme/widgets"
    );
  });

  test("orgOf derives the owner, not the whole spelling", () => {
    expect(orgOf("/acme/widgets")).toBe("acme");
    expect(orgOf("/acme")).toBe("acme");
  });

  test("the config dir and the repo resolver agree on the spelling", () => {
    expect(resolveConfigDirName({ GITHUB_REPO: "/acme/widgets" })).toBe(
      "widgets"
    );
    expect(resolveRepoFromEnv({ GITHUB_REPO: "/acme/widgets" })).toBe(
      "acme/widgets"
    );
  });

  test("a lone slash resolves to no repo, not to a garbage path", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: "/" })).toBe("");
  });
});
