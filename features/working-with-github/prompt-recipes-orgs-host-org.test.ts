import { describe, expect, test } from "bun:test";
// Regression (#321): a GITHUB_REPO spelling whose ORGANIZATION segment is
// literally `github.com` — `github.com/orgs/github.com`,
// `https://github.com/orgs/github.com`, `orgs/github.com` (the hostless orgs
// page), `github.com:orgs/github.com` (the scp form) — or whose org segment is
// the reserved-looking word `users`/`organizations` — made the REPO= recipe
// (both prompt.md copies and mint-token.ts's header copy) answer `""` while
// all four code resolvers answered the ORG, the one-spelling contract the
// corpus pins (README: "every resolver in this feature tolerates the other
// spellings too").
//
// Measured pre-fix (all surfaces, one spelling):
//   github.com/orgs/github.com   orgOf = "github.com"  repo = "github.com"
//                                allow = {github.com}  cfg = "github.com"
//                                REPO= recipe = ""
//   orgs/github.com              same five-way split
//   github.com/orgs/users       resolvers = "users"   recipe = ""
//   orgs/organizations          resolvers = "organizations"  recipe = ""
//
// Root cause: the recipe's orgs-page rule DID extract the org — the trace
// shows `s#…github.com[/:]+(orgs|organizations|users)/([^/]+)…#` matching the
// whole spelling — but the extraction landed on the t/label branch that runs
// the generic LAST-host strip and the two tail EMPTIERS
// (`s#^(organizations|users)$##` and the final bare-host rule
// `s#^(scheme://)?(user@)?github.com$##`) AFTER it, and an org whose value IS
// the host word — `github.com` — or IS a reserved word — `users`,
// `organizations` — was eaten to `""` by exactly those emptiers, while the
// code resolvers return the extracted value verbatim. The recipe has no
// settled-answer branch for the orgs-page extraction the way its hosted
// pair rule does (`t wwg317c`).
//
// Fix shape (all three recipe copies, byte-identical):
// - an ANCHORED orgs-page extractor (`^scheme?user?HOST[:port]?[/:]+(orgs|…)/
//   ([^/]+)…`) ahead of the unanchored one, each with a settled-branch
//   (`t wwg321s`) that jumps past the emptiers — the recipe's own
//   flag-clear/label idiom (`twwg317z; :wwg317z`) clearing the flag first;
// - the hosted org-URL reading (`https://github.com/github.com`, the org page
//   of an org literally named `github.com`) settles through the generic
//   LAST-host strip the same way;
// - the hostless orgs extractor keeps its own flag-clear and settled branch;
// - the tail reorders the bare-host emptier ahead of the deep-collapse rules
//   so a settled value never flows through a rule that can misread it, while
//   every non-settled spelling keeps its pinned answer (the full pinned
//   corpus — 162 spellings across the recipe suites — is byte-identical
//   pre/post fix, verified by the differential run in the PR).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

const here = dirname(fileURLToPath(import.meta.url));

const prompt = readFileSync(join(here, "prompt.md"), "utf-8");
const mintSource = readFileSync(join(here, "scripts", "mint-token.ts"), "utf-8");

/** Every fenced bash block in the prompt (indented list fences included). */
const fences: readonly string[] = [
  ...prompt.matchAll(/```bash[^\n]*\n([\s\S]*?)```/g),
].map((match) => match[1] ?? "");

const isNormalizerLine = (line: string): boolean =>
  line.trimStart().startsWith(`REPO=$(printf '%s' "$GITHUB_REPO"`);

/** The recipe, extracted from a source file's normalizer line. */
const recipeOf = (src: string): string => {
  const line = src
    .split("\n")
    .map((candidate) => candidate.trim())
    // mint-token.ts's copy rides inside a block comment: its line carries a
    // leading `*` the strip below removes, so find on the raw marker the way
    // the mint-header suite does, then normalize.
    .find((candidate) => candidate.includes(`REPO=$(printf '%s' "$GITHUB_REPO"`));
  const match =
    line === undefined
      ? null
      : /^REPO=\$\(printf '%s' "\$GITHUB_REPO" \| sed -E '([^']+)'\)$/u.exec(
          line.replace(/^\s*\*\s?/u, "").trim()
        );
  return match?.[1] ?? "";
};

/** Run one extracted recipe exactly as the doc prints it. */
const runRecipe = (recipe: string, raw: string): string => {
  expect(recipe).not.toBe("");
  return execFileSync(
    "bash",
    [
      "-c",
      `REPO=$(printf '%s' "$GITHUB_REPO" | sed -E '${recipe}')\nprintf '%s' "$REPO"`,
    ],
    {
      encoding: "utf-8",
      env: { ...process.env, GITHUB_REPO: raw },
    }
  );
};

/** The prompt's first recipe (both copies must agree; the suite pins that). */
const promptRecipe = recipeOf(prompt);
/** mint-token.ts's header copy of the same recipe. */
const mintRecipe = recipeOf(mintSource);

/** The class proper: an orgs page whose ORG segment collides with a host word
 *  or a reserved word the recipe's tail emptiers would otherwise eat. */
const ORGS_HOST_ORG: readonly string[] = [
  "github.com/orgs/github.com",
  "https://github.com/orgs/github.com",
  "orgs/github.com",
  "/orgs/github.com",
  "github.com:orgs/github.com",
  "git@github.com:orgs/github.com",
  "ssh://git@github.com:22/orgs/github.com",
  "https://GitHub.com/orgs/GitHub.com",
  "github.com/orgs/github.com/acme",
  "https://github.com/orgs/github.com/teams",
  "github.com/organizations/github.com",
  "github.com/users/github.com",
];

/** The reserved-word org spellings: `users`/`organizations` as the org. */
const RESERVED_WORD_ORG: readonly { readonly expected: string; readonly raw: string }[] = [
  { expected: "users", raw: "github.com/orgs/users" },
  { expected: "users", raw: "orgs/users" },
  { expected: "organizations", raw: "github.com/orgs/organizations" },
  { expected: "organizations", raw: "orgs/organizations" },
];

/** The org-URL spelling: an org page of an org literally named `github.com`. */
const ORG_URL_HOST_ORG: readonly string[] = [
  "https://github.com/github.com",
  "github.com/github.com",
  "github.com:22/github.com",
  "ssh://git@github.com:22/github.com",
  "users/github.com",
];

describe("an orgs page whose org segment is github.com resolves on one spelling contract in every surface", () => {
  test("the code resolvers answer the org verbatim (the contract the recipe must meet)", () => {
    for (const spelling of [...ORGS_HOST_ORG, ...ORG_URL_HOST_ORG]) {
      const org = orgOf(spelling);
      expect(org).toBe(
        spelling.includes("GitHub.com") ? "GitHub.com" : "github.com"
      );
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe(org);
      expect([
        ...resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling }),
      ]).toEqual(["github.com"]);
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe(
        "github.com"
      );
    }
  });

  test("every recipe copy answers the same org, never the empty string", () => {
    const recipes: readonly [string, string][] = [
      ["prompt.md", promptRecipe],
      ["mint-token.ts", mintRecipe],
    ];
    for (const [name, recipe] of recipes) {
      for (const spelling of ORGS_HOST_ORG) {
        expect(runRecipe(recipe, spelling)).toBe(
          spelling.includes("GitHub.com") ? "GitHub.com" : "github.com"
        );
      }
      // org-URL spellings
      for (const spelling of ORG_URL_HOST_ORG) {
        expect(runRecipe(recipe, spelling)).toBe("github.com");
      }
    }
  });

  test("the reserved-word org spellings keep their extracted org too", () => {
    for (const { expected, raw } of RESERVED_WORD_ORG) {
      expect(orgOf(raw)).toBe(expected);
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe(expected);
      expect(runRecipe(promptRecipe, raw)).toBe(expected);
      expect(runRecipe(mintRecipe, raw)).toBe(expected);
    }
  });

  test("the orgs-page INDEX spellings and the bare host still normalize to nothing", () => {
    for (const spelling of [
      "github.com/orgs",
      "https://github.com/orgs",
      "github.com/organizations",
      "github.com/users",
      "https://github.com/users",
      "github.com",
      "https://github.com",
      "git@github.com",
      "ssh://git@github.com",
      "users",
      "organizations",
    ]) {
      expect(orgOf(spelling === "users" || spelling === "organizations" ? spelling : spelling)).toBe("");
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe("");
      expect(runRecipe(promptRecipe, spelling)).toBe("");
      expect(runRecipe(mintRecipe, spelling)).toBe("");
    }
  });

  test("the mid-string host classes keep their pinned answers (corpus guard)", () => {
    for (const [spelling, expected] of [
      ["acme/github.com/widgets", "widgets"],
      ["x/github.com/y/z", "y/z"],
      ["owner/repo/github.com/tail", "tail"],
      ["github.com/x/github.com/y/z", "x/github.com"],
      ["github.com/github.com/o/r", "github.com/o"],
      ["https://github.com/acme/github.com/tree/main", "acme/github.com"],
      ["git@github.com::acme", ":acme"],
      ["github.com::acme", ":acme"],
      ["https://github.com::acme/widgets", ":acme/widgets"],
      ["github.com:22:22/acme", "22/acme"],
      ["git@github.com://acme/widgets", "acme/widgets"],
      ["https://raw.githubusercontent.com/acme/github.com/widgets/main/x.ts", "widgets/main"],
      ["https://github.com/users/acme/followers", "acme"],
      ["https://api.github.com//users/acme", "acme"],
      // #324: these two rows pinned the recipe DIVERGENCE the issue filed —
      // the code resolvers answer "" / "acme" for these spellings (the
      // orgs-page reading), while the recipe left the junk prefix standing.
      // They now pin the one-spelling contract: the recipe answers exactly
      // what the code resolvers answer. See prompt-recipes-reserved-tail.
      ["x/github.com/users", ""],
      ["x/github.com/orgs/acme", "acme"],
    ] as const) {
      expect(runRecipe(promptRecipe, spelling)).toBe(expected);
      expect(runRecipe(mintRecipe, spelling)).toBe(expected);
    }
  });
});
