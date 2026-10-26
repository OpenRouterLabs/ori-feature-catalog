import { describe, expect, test } from "bun:test";
// Regression: a PURPOSE-ONLY invocation (`mint-token.ts --purpose reviewer`,
// no --repo/--org) derives its own-org target from GITHUB_REPO — and a
// GITHUB_REPO spelling that names NO org at all (the organizations-page INDEX
// URL `https://github.com/orgs`, a bare `organizations` word, the ported index
// spellings) flowed the raw spelling in as the target. `readGhAppCredentials`
// treats an ORGLESS target exactly like the bare default-app request, so
// `mintInstallationToken({ targetRepo, purpose })` looked the registry up
// under the empty org, found no row, and silently minted the DEFAULT App's
// token — dropping both the caller's --purpose (a reviewer-only request that
// minted the maintainer App's token, the exact silent identity swap
// resolveMintDeps's own-org derivation exists to close) and every routing
// decision after it.
//
// Verified live as a failing probe on 2026-10-26:
//
//   $ GITHUB_REPO="https://github.com/orgs" \
//     bun mint-token.ts --purpose reviewer
//   gh-app-token: no registered app for  (reviewer); falling back to…
//   ghs_…  ← the DEFAULT App's token
//
// — the same silent-swap class #98/#107 closed for the --repo flag and
// #216/#221 closed for every orgless spelling of it
// (unresolvableRepoValue); the purpose-only derivation is the one path left
// that minted a token from an orgless spelling. The CLI must fail loudly
// instead, naming the env spelling (the #207/#219/#220 "name the actual
// cause" contract), and resolveMintDeps returns null so the entrypoint never
// mints.
import { orgOf } from "../gh-app-registry.ts";
import { parseMintArgs, resolveMintDeps } from "./mint-token.ts";

/** The orgless GITHUB_REPO spellings the derivation can inherit. */
const ORGLESS_OWN_REPO: readonly (readonly [
  string,
  Record<string, string | undefined>,
])[] = [
  ["https://github.com/orgs", { GITHUB_REPO: "https://github.com/orgs" }],
  [
    "https://github.com/organizations",
    { GITHUB_REPO: "https://github.com/organizations" },
  ],
  ["github.com/orgs", { GITHUB_REPO: "github.com/orgs" }],
  [
    "git@github.com:organizations",
    { GITHUB_REPO: "git@github.com:organizations" },
  ],
  ["ssh://git@github.com:22/orgs", { GITHUB_REPO: "ssh://git@github.com:22/orgs" }],
  ["organizations", { GITHUB_REPO: "organizations" }],
];

describe("resolveMintDeps (the purpose-only own-org derivation)", () => {
  test("an orgless GITHUB_REPO never becomes a silent default mint", () => {
    // Pre-fix: resolveMintDeps returned { purpose, targetRepo: raw } for every
    // orgless spelling, and the entrypoint minted the DEFAULT App. Null is
    // the CLI's documented fail-loudly signal.
    for (const [, env] of ORGLESS_OWN_REPO) {
      expect(resolveMintDeps({ purpose: "reviewer" }, env)).toBeNull();
    }
  });

  test("the corpus is the documented no-owner answer (the guard's anchor)", () => {
    for (const [spelling] of ORGLESS_OWN_REPO) {
      expect(orgOf(spelling)).toBe("");
    }
  });

  test("a healthy GITHUB_REPO still routes the purpose to its own org", () => {
    expect(
      resolveMintDeps({ purpose: "reviewer" }, { GITHUB_REPO: "acme/widgets" })
    ).toEqual({ purpose: "reviewer", targetRepo: "acme/widgets" });
    // URL spellings keep flowing raw — orgOf normalizes downstream, and the
    // registry key and allowlist both derive through it.
    expect(
      resolveMintDeps(
        { purpose: "reviewer" },
        { GITHUB_REPO: "https://github.com/acme/widgets.git/" }
      )
    ).toEqual({
      purpose: "reviewer",
      targetRepo: "https://github.com/acme/widgets.git/",
    });
  });

  test("an unset GITHUB_REPO keeps its documented null (no target derivable)", () => {
    expect(resolveMintDeps({ purpose: "reviewer" }, {})).toBeNull();
    expect(
      resolveMintDeps({ purpose: "reviewer" }, { GITHUB_REPO: "   " })
    ).toBeNull();
  });

  test("a purposeless bare-default invocation never touches the derivation", () => {
    for (const [, env] of ORGLESS_OWN_REPO) {
      expect(resolveMintDeps({}, env)).toEqual({});
    }
  });
});