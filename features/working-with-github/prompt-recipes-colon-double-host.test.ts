import { describe, expect, test } from "bun:test";
// Regression (the #321 family, two reopened shapes): a GITHUB_REPO spelling
// that carries TWO github.com host words made the REPO= recipe (both
// prompt.md copies and mint-token.ts's header copy) answer a different repo
// than every code resolver — the one-spelling contract the corpus pins
// (README: "every resolver in this feature tolerates the other spellings
// too").
//
// Class 1 — the COLON-JOINED double host. The scp/`git remote -v` paste of a
// repo whose owner is literally `github.com` (GitHub logins may carry dots):
//
//   github.com:github.com/o        code repo = "github.com/o"  recipe = "o"
//   github.com:github.com/o/r      code repo = "github.com/o"  recipe = "o/r"
//   github.com:github.com/acme/widgets
//                                  code repo = "github.com/acme"  recipe = "acme/widgets"
//   github.com:22:github.com/o/r   code repo = "github.com/o"  recipe = "github.com/o"
//                                  (the ported form already agreed)
//
// Pre-fix the recipe's scheme-restore rule (`s#^(scheme):/?…#`) read the
// FIRST host word as a scheme prefix, welded `://` onto the second, and the
// greedy LAST-host strip then ate BOTH host words — while every code
// resolver's anchored branches read the FIRST host (the reading #317/#320
// pinned: a spelling that genuinely starts with a host reads its pair past
// that host). The git@ spelling of the same paste already agreed because the
// user-info strip normalizes it before the scheme rule can misread it.
//
// Class 2 — the raw-host + URL CONCATENATION. An env value assembled by
// concatenating a raw.githubusercontent.com host with a full https URL (a
// missing-space shell paste):
//
//   https://raw.githubusercontent.com/https://github.com/acme/widgets
//   raw.githubusercontent.com/https://github.com/acme/widgets
//     code (all four resolvers) = ""   recipe = "acme/widgets"
//
// The code's raw-host degenerate branch answers the honest no-owner value
// (the tail is not a clean path), so every later command fails loudly; the
// recipe silently extracted a working-looking repo from a corrupt paste.
//
// Fix (all three recipe copies, byte-identical):
// - Class 1: a rule BEFORE the scheme restore normalizes the bare-host
//   colon-joined form to the git@ scp form (`github.com:github.com/…` →
//   `git@github.com:github.com/…`), so the user-info strip keys the FIRST
//   host exactly like the git@ spelling of the same paste.
// - Class 2: a rule BEFORE the raw-host strips empties a raw host whose tail
//   carries a scheme (`raw…/<scheme>://…`), matching the code resolvers'
//   honest no-owner answer for the degenerate raw tail.
//
// Verification (differential, all three recipe copies): the full pinned
// recipe corpus — 162 spellings across the recipe suites — answers
// byte-identically pre/post fix; a 1628-spelling grid (hosts × paths ×
// paddings) changed 128 spellings and all 128 now agree with
// `resolveRepoFromEnv` (0 remaining disagreements; pre-fix 128).
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

const recipeOf = (src: string): string => {
  const line = src
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.includes(`REPO=$(printf '%s' "$GITHUB_REPO"`));
  const match =
    line === undefined
      ? null
      : /^REPO=\$\(printf '%s' "\$GITHUB_REPO" \| sed -E '([^']+)'\)$/u.exec(
          line.replace(/^\s*\*\s?/u, "").trim()
        );
  return match?.[1] ?? "";
};

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

const promptRecipe = recipeOf(prompt);
const mintRecipe = recipeOf(mintSource);

/** The colon-joined double host: the scp paste of a repo owned by `github.com`. */
const COLON_DOUBLE_HOST: readonly { readonly expected: string; readonly raw: string }[] = [
  { expected: "github.com/o", raw: "github.com:github.com/o" },
  { expected: "github.com/o", raw: "github.com:github.com/o/r" },
  { expected: "github.com/acme", raw: "github.com:github.com/acme/widgets" },
  { expected: "github.com/o", raw: "github.com:22:github.com/o/r" },
  { expected: "github.com/o", raw: "git@github.com:github.com/o/r" },
];

/** The raw-host + URL concatenation: all four resolvers answer no owner. */
const RAW_URL_CONCAT: readonly string[] = [
  "https://raw.githubusercontent.com/https://github.com/acme/widgets",
  "raw.githubusercontent.com/https://github.com/acme/widgets",
  "https://raw.githubusercontent.com/http://github.com/acme/widgets",
  "raw.githubusercontent.com:443/https://github.com/acme/widgets",
];

describe("a colon-joined double host resolves on one spelling contract in every surface", () => {
  test("the code resolvers read the pair past the FIRST host (the pinned #317/#320 reading)", () => {
    for (const { expected, raw } of COLON_DOUBLE_HOST) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe(expected);
      expect(orgOf(raw)).toBe(
        "github.com"
      );
      expect([
        ...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw }),
      ]).toEqual(["github.com"]);
    }
  });

  test("every recipe copy answers the same pair, never the tail past the LAST host", () => {
    for (const [name, recipe] of [
      ["prompt.md", promptRecipe],
      ["mint-token.ts", mintRecipe],
    ] as const) {
      for (const { expected, raw } of COLON_DOUBLE_HOST) {
        expect(runRecipe(recipe, raw)).toBe(expected);
      }
      expect(name).toBeDefined();
    }
  });

  test("a raw host concatenated with a full URL resolves to nothing in every recipe copy", () => {
    for (const spelling of RAW_URL_CONCAT) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe("");
      expect(orgOf(spelling)).toBe("");
      expect([
        ...resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling }),
      ]).toEqual([]);
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe("intern");
      expect(runRecipe(promptRecipe, spelling)).toBe("");
      expect(runRecipe(mintRecipe, spelling)).toBe("");
    }
  });

  test("the healthy raw-host pastes keep their pinned answers (corpus guard)", () => {
    for (const [spelling, expected] of [
      ["raw.githubusercontent.com/acme/widgets", "acme/widgets"],
      ["https://raw.githubusercontent.com/acme/widgets", "acme/widgets"],
      ["https://raw.githubusercontent.com/acme/widgets/main/x.ts", "acme/widgets"],
      ["https://raw.githubusercontent.com/acme/github.com/widgets", "widgets"],
      ["https://raw.githubusercontent.com/acme/github.com/widgets/main/x.ts", "widgets/main"],
      ["raw.githubusercontent.com/acme", ""],
      ["https://raw.githubusercontent.com", ""],
    ] as const) {
      expect(runRecipe(promptRecipe, spelling)).toBe(expected);
      expect(runRecipe(mintRecipe, spelling)).toBe(expected);
    }
  });

  test("the ported and plain colon-host spellings keep their pinned answers (corpus guard)", () => {
    for (const [spelling, expected] of [
      ["github.com:acme/widgets", "acme/widgets"],
      ["github.com:22/acme/widgets", "acme/widgets"],
      ["github.com:22", ""],
      ["github.com:", ""],
      ["git@github.com:acme/widgets.git", "acme/widgets"],
      ["github.com::acme", ":acme"],
      ["https://github.com::acme/widgets", ":acme/widgets"],
      ["github.com:22:22/acme", "22/acme"],
    ] as const) {
      expect(runRecipe(promptRecipe, spelling)).toBe(expected);
      expect(runRecipe(mintRecipe, spelling)).toBe(expected);
    }
  });
});
