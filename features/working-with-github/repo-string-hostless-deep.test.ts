import { describe, expect, test } from "bun:test";
// Regression: a HOSTLESS deep paste — bare `owner/repo/<tail>`, the URL path
// of a copied blob/tree/PR/releases address pasted without the host — broke
// the repo-string contract between the prompt's `REPO=` sed recipe and the
// code resolvers:
//
//   - `resolveRepoFromEnv` returned the whole string, so every
//     `repos/{repo}` API route 404'd (the class the hosted deep-URL fix
//     #159 closed, reopened through the hostless path);
//   - `orgOf` returned the whole string as the "org", so a registry row
//     registered from a deep `--repo`/`--org` paste could never match the
//     org a mint derives — every mint silently fell back to the default
//     App (#101's class);
//   - `resolveAllowedOrgs` (routed through `orgOf`) keyed the fail-closed
//     allowlist on the whole path, a login no installation owner carries,
//     so every mint failed closed with no hint the spelling was the cause;
//   - the prompt's `REPO=` sed recipe collapsed the same paste to its
//     `owner/repo` tail (`s#(^[^/]+/[^/]+)(/.*)?$#\1#`), so the recipe and
//     the resolvers silently disagreed — one spelling contract, four
//     resolvers (README: "every resolver in this feature tolerates the
//     other spellings too").
//
// `resolveConfigDirName` already collapsed the paste (its repo regex keys on
// the `owner/repo` pair with a tolerated tail), so this suite pins the
// other three against the same corpus.

import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";

const HOSTLESS_DEEP_PATHS: string[] = [
  "acme/widgets/tree/main",
  "acme/widgets/blob/main/src/x.ts",
  "acme/widgets/pull/42",
  "acme/widgets/releases",
  "acme/widgets/tree/main/", // trailing slash too
];

describe("a hostless deep paste resolves like its hosted deep-URL sibling", () => {
  test.each(HOSTLESS_DEEP_PATHS)(
    "resolveRepoFromEnv collapses %s to owner/repo",
    (spelling: string) => {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe(
        "acme/widgets"
      );
    }
  );

  test("the single-letter owner/repo paste collapses too", () => {
    // `o/r/tree/main` — the repo named `r` under the owner `o`, pasted from a
    // short URL — must collapse to `o/r`, never stay whole.
    expect(resolveRepoFromEnv({ GITHUB_REPO: "o/r/tree/main" })).toBe("o/r");
  });

  test.each(HOSTLESS_DEEP_PATHS)(
    "orgOf extracts the owner from %s",
    (spelling: string) => {
      expect(orgOf(spelling)).toBe("acme");
    }
  );

  test("orgOf extracts the single-letter owner from the short paste", () => {
    expect(orgOf("o/r/tree/main")).toBe("o");
  });

  test.each(HOSTLESS_DEEP_PATHS)(
    "the allowlist carries the owner, not the whole path, for %s",
    (spelling: string) => {
      expect([
        ...resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling }),
      ]).toEqual(["acme"]);
    }
  );

  test.each(HOSTLESS_DEEP_PATHS)(
    "resolveConfigDirName still keys on the repo name for %s",
    (spelling: string) => {
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe("widgets");
    }
  );

  test("the flat spellings keep their established resolutions", () => {
    // The new hostless-deep branch must not disturb the flat corpus.
    expect(resolveRepoFromEnv({ GITHUB_REPO: "acme/widgets" })).toBe(
      "acme/widgets"
    );
    expect(resolveRepoFromEnv({ GITHUB_REPO: "acme/widgets/" })).toBe(
      "acme/widgets"
    );
    expect(orgOf("acme/widgets")).toBe("acme");
    expect(orgOf("acme")).toBe("acme"); // a bare org keeps its pass-through
    expect(resolveRepoFromEnv({ GITHUB_REPO: "acme" })).toBe("acme");
  });
});