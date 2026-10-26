import { describe, expect, test } from "bun:test";
// Regression: an ORG-page spelling whose scp/ssh USER-INFO word is not the
// literal `git` — `ssh://deploy@github.com/acme`, `bob@github.com/acme`,
// `deploy@github.com:22/acme` (a deploy-key or CI remote form `git remote -v`
// produces) — diverged across the four resolvers, violating the README's
// one-spelling contract exactly the way the #169/#175/#177 org-URL class did:
//
//   - `resolveRepoFromEnv` resolved `acme` (its host regexes carry no
//     user-info anchor, so the `[^/]+` owner segment read past the host);
//   - `orgOf` resolved `acme` (same reason);
//   - `resolveAllowedOrgs` allowlisted `acme`;
//   - `resolveConfigDirName` sanitized the WHOLE URL — `ssh-deploy-github.com-acme`
//     — because its org-URL branch is `^`-anchored on a host word that must
//     start the string, and the user-info word stands before it: the
//     single-segment `org` path then has no `owner/repo` pair for the repo
//     regexes, and the fallback named the dir after the raw URL.
//
// One `GITHUB_REPO` spelling therefore keyed the registry/cache DB on a
// different directory than every sibling resolver derived — the DB silently
// migrated the moment the env var's spelling carried a non-`git` user word,
// orphaning every row already written (#113's class, reopened through the
// user-info form). The ORG spelling is the one that breaks: a full
// `owner/repo` pair still resolves through the repo regexes (pinned below),
// because the two-segment match does not care what precedes the owner.

import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";

const USER_INFO_ORG: readonly string[] = [
  "ssh://deploy@github.com/acme",
  "bob@github.com/acme",
  "deploy@github.com:22/acme",
];

describe("an org-page spelling with a non-git user-info word resolves like the git@ form", () => {
  test("orgOf resolves the org, like the git@ spelling", () => {
    expect(orgOf("git@github.com/acme")).toBe("acme");
    for (const spelling of USER_INFO_ORG) {
      expect(orgOf(spelling)).toBe("acme");
    }
  });

  test("resolveRepoFromEnv resolves the org, like the git@ spelling", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: "git@github.com/acme" })).toBe(
      "acme"
    );
    for (const spelling of USER_INFO_ORG) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe("acme");
    }
  });

  test("resolveAllowedOrgs carries the org, so mints do not fail closed", () => {
    for (const spelling of USER_INFO_ORG) {
      expect([
        ...resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling }),
      ]).toEqual(["acme"]);
    }
  });

  test("resolveConfigDirName agrees — the org, never the sanitized URL", () => {
    // The dir must be the org the three siblings resolve (`acme`), matching
    // the `git@github.com/acme` spelling — never a sanitized raw URL that
    // silently migrates the registry/cache DB (#113's class).
    expect(resolveConfigDirName({ GITHUB_REPO: "git@github.com/acme" })).toBe(
      "acme"
    );
    for (const spelling of USER_INFO_ORG) {
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe("acme");
    }
  });
});

describe("a full owner/repo pair with a non-git user-info word keeps resolving", () => {
  test("the two-segment path resolves through every resolver", () => {
    // The repo form never diverged — the two-segment regexes match the
    // owner/repo tail regardless of what precedes the host. Pin it so the
    // fix cannot regress the pair form while closing the org form.
    expect(
      resolveRepoFromEnv({ GITHUB_REPO: "ssh://deploy@github.com/acme/widgets" })
    ).toBe("acme/widgets");
    expect(orgOf("ssh://deploy@github.com/acme/widgets")).toBe("acme");
    expect(
      resolveConfigDirName({
        GITHUB_REPO: "ssh://deploy@github.com/acme/widgets",
      })
    ).toBe("widgets");
  });
});
