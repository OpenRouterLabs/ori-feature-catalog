import { describe, expect, test } from "bun:test";
// A QUERY or FRAGMENT suffix carrying a SLASH (`o/r?q=repo:acme/widgets`,
// `https://github.com/o/r?after=v1.0/v2.0`, `o/r#github.com/frag` — the
// address-bar paste of a repo SEARCH or a history-paginated compare URL)
// survived the REPO= recipe's query/fragment strips, whose `[^/]*` guards
// keyed on a slash-free suffix. The surviving suffix then fed the recipe's
// own DEEP-URL rule (`s#^/*([^/]+/[^/]+)(/.*)?$#\1#`), which folded
// `?q=repo:acme` into the REPO SEGMENT — `resolveRepoFromEnv` answered the
// healthy `acme/widgets` for the same spelling while the recipe answered
// `acme/widgets?q=repo:acme` (verified: rule 38 of the recipe), a value
// `gh --repo` rejects and every `repos/{repo}` route 404s on — the
// one-spelling contract the query/fragment corpus pins (#232's class),
// reopened through a slashed suffix. The resolvers strip `?.*$` and
// `#.*$` unconditionally; the recipe now does the same.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";
import { orgOf } from "@ori-monorepo/working-with-github/gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";

const here = dirname(fileURLToPath(import.meta.url));

const recipeOf = (src: string): string => {
  const line = src
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.includes("REPO=$(printf '%s' \"$GITHUB_REPO\""));
  const match =
    line === undefined
      ? null
      : /^REPO=\$\(printf '%s' "\$GITHUB_REPO" \| sed -E '([^']+)'\)$/u.exec(
          line.replace(/^\s*\*\s?/u, "").trim()
        );
  return match?.[1] ?? "";
};

const runRecipe = (recipe: string, raw: string): string =>
  execFileSync(
    "bash",
    [
      "-c",
      `REPO=$(printf '%s' "$GITHUB_REPO" | sed -E '${recipe}')\nprintf '%s' "$REPO"`,
    ],
    { encoding: "utf-8", env: { ...process.env, GITHUB_REPO: raw } }
  );

const RECIPE_SITES: readonly (readonly [string, string])[] = [
  ["prompt.md", join(here, "prompt.md")],
  ["mint-token.ts header", join(here, "scripts", "mint-token.ts")],
];

const SLASHED_SUFFIX_SPELLINGS: readonly string[] = [
  "acme/widgets?q=repo:acme/widgets",
  "https://github.com/acme/widgets?q=repo:acme/widgets",
  "acme/widgets?q=is:pr+github.com/x",
  "https://github.com/acme/widgets?after=v1.0/v2.0",
  "acme/widgets#github.com/frag",
  "https://github.com/acme/widgets#start=hash-0/x",
];

describe("a slashed QUERY or FRAGMENT suffix strips like the code resolvers", () => {
  for (const [name, path] of RECIPE_SITES) {
    const recipe = recipeOf(readFileSync(path, "utf-8"));

    test(`${name} carries a recipe`, () => {
      expect(recipe).not.toBe("");
    });

    for (const raw of SLASHED_SUFFIX_SPELLINGS) {
      test(`${name} resolves ${JSON.stringify(raw)} to the resolver's answer`, () => {
        const resolver = resolveRepoFromEnv({ GITHUB_REPO: raw });
        expect(resolver).toBe("acme/widgets");
        expect(runRecipe(recipe, raw)).toBe(resolver);
      });
    }
  }

  test("every resolver keeps its healthy answer for the same spellings", () => {
    for (const raw of SLASHED_SUFFIX_SPELLINGS) {
      expect(orgOf(raw)).toBe("acme");
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw })]).toEqual([
        "acme",
      ]);
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("acme/widgets");
    }
  });

  test("the slash-free suffix spellings keep their established answers", () => {
    for (const raw of [
      "acme/widgets?tab=readme",
      "https://github.com/acme/widgets?tab=readme",
      "acme/widgets#anchor",
      "https://github.com/acme/widgets#frag",
      "o/r.git?tab=1",
      "https://github.com/acme/widgets.git?diff=split",
      "https://github.com/acme/widgets?q=",
    ]) {
      const resolver = resolveRepoFromEnv({ GITHUB_REPO: raw });
      expect(runRecipe(recipeOf(readFileSync(join(here, "prompt.md"), "utf-8")), raw)).toBe(
        resolver
      );
      expect(resolver).toBe(raw.startsWith("o/r") ? "o/r" : "acme/widgets");
    }
  });
});
