import { describe, expect, test } from "bun:test";
// Regression: an explicitly-passed --repo/--org that names NO target org —
// the organizations-page INDEX URL (`https://github.com/orgs`), a bare
// `organizations` word, the ported index spellings — `orgOf` collapses all of
// them to `""`, the documented no-owner answer (repo-string-orgs-index.test.ts
// pins the resolver side). Pre-fix the parse let the spelling flow into
// `mintInstallationToken({ targetRepo })`, where `readGhAppCredentials`
// treats an ORGLESS target exactly like the bare default-app request:
//
//   $ mint-token.ts --repo https://github.com/orgs --purpose reviewer
//   gh-app-token: no registered app for  (reviewer); falling back to…
//   ghs_…  ← the DEFAULT App's token, minted for the GITHUB_REPO org
//
// — the caller's explicit target and the role App they asked for were both
// silently DROPPED (verified live as a failing probe on 2026-10-26): a
// silent identity swap through the one CLI that mints credentials, the
// #98/#107 class every OTHER shape of this flag already fails loudly on
// (missing value, repeated flag), and the exact spelling the sibling CLIs
// name loudly since #219/#220 (commit-via-api `--repo "…" resolves to no
// owner/repo`, cleanup-worktrees `--repo "…" resolves to no owner/repo`,
// register-gh-app's normalized-org guard). The mint CLI now refuses at the
// parse, naming the spelling, and resolveMintDeps returns null so the
// entrypoint never mints.
import { parseMintArgs, resolveMintDeps } from "./mint-token.ts";
import { orgOf } from "../gh-app-registry.ts";

const ORGLESS_SPELLINGS: readonly string[] = [
  "https://github.com/orgs",
  "https://github.com/organizations",
  "github.com/orgs",
  "git@github.com:organizations",
  "ssh://git@github.com:22/orgs",
  "organizations",
];

describe("an explicitly-passed --repo that names no org is a usage error, not a silent default mint", () => {
  test("orgOf confirms the corpus is the documented no-owner answer", () => {
    // Guard the corpus itself: every spelling below must resolve to ""
    // (repo-string-orgs-index.test.ts pins the same contract on the
    // resolver) — a corpus member that resolves to an org would make this
    // suite prove nothing.
    for (const spelling of ORGLESS_SPELLINGS) {
      expect(orgOf(spelling)).toBe("");
    }
  });

  test("parseMintArgs refuses the spelling, carrying it for the diagnostic", () => {
    for (const spelling of ORGLESS_SPELLINGS) {
      expect(parseMintArgs(["--repo", spelling])).toEqual({
        unresolvableRepoValue: spelling,
      });
      // --org is the same flag by alias, and a --purpose rides along.
      expect(
        parseMintArgs(["--org", spelling, "--purpose", "reviewer"])
      ).toEqual({
        purpose: "reviewer",
        unresolvableRepoValue: spelling,
      });
    }
  });

  test("resolveMintDeps is null — the CLI must fail loudly, never mint", () => {
    // Pre-fix: resolveMintDeps returned the args unchanged and the entrypoint
    // minted the DEFAULT App for the GITHUB_REPO org, dropping the target
    // and the purpose. Null is the CLI's documented "fail loudly" signal.
    for (const spelling of ORGLESS_SPELLINGS) {
      expect(
        resolveMintDeps(
          { purpose: "reviewer", targetRepo: spelling } as never,
          { GITHUB_REPO: "acme/widgets" }
        )
      ).toBeNull();
    }
  });

  test("a real owner/repo target keeps flowing through unchanged", () => {
    // The happy path a regression here would break: an ordinary spelling
    // never trips the guard.
    expect(
      parseMintArgs(["--repo", "acme/widgets", "--purpose", "reviewer"])
    ).toEqual({
      purpose: "reviewer",
      targetRepo: "acme/widgets",
    });
    expect(
      resolveMintDeps(
        parseMintArgs(["--repo", "acme/widgets", "--purpose", "reviewer"]),
        { GITHUB_REPO: "acme/widgets" }
      )
    ).toEqual({
      purpose: "reviewer",
      targetRepo: "acme/widgets",
    });
  });

  test("an org-naming spelling (orgs/<org>) still routes, and a bare orgs word keeps its pass-through", () => {
    // The org-NAMING spellings are NOT the index spellings and must keep
    // working; a bare `orgs` word is a login by the documented split, so it
    // keeps its pass-through too.
    expect(parseMintArgs(["--repo", "github.com/orgs/acme"])).toEqual({
      targetRepo: "github.com/orgs/acme",
    });
    expect(parseMintArgs(["--repo", "orgs/acme"])).toEqual({
      targetRepo: "orgs/acme",
    });
    expect(parseMintArgs(["--repo", "orgs"])).toEqual({
      targetRepo: "orgs",
    });
  });
});