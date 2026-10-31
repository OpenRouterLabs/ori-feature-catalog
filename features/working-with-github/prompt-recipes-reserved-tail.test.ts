import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { orgOf } from "./gh-app-registry.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const prompt = readFileSync(join(dir, "prompt.md"), "utf-8");
const mintSource = readFileSync(join(dir, "scripts", "mint-token.ts"), "utf-8");

const recipeOf = (source: string): string => {
  const match =
    /REPO=\$\(printf '%s' "\$GITHUB_REPO" \| sed -E '([^']*)'\)/.exec(source);
  if (match === null) {
    throw new Error("the REPO= recipe was not found in the source");
  }
  return match[1].replaceAll("\\'", "'");
};

const runRecipe = (recipe: string, spelling: string): string =>
  execFileSync("sed", ["-E", recipe], {
    encoding: "utf-8",
    input: spelling,
  })
    .toString()
    .replace(/\n$/u, "");

const promptRecipe = recipeOf(prompt);
const mintRecipe = recipeOf(mintSource);

// #324: a HOSTLESS mid-string spelling — a `github.com` segment inside a bare
// path — whose tail past that segment is a RESERVED word (`users`,
// `organizations`), makes the REPO= recipe answer a different value than every
// code resolver. Measured pre-fix (all surfaces, one spelling):
//   x/github.com/users          orgOf = ""  repo = ""  recipe = "x/"
//   x/github.com/organizations  same split
//   y/github.com/users/pull/1   orgOf = "pull"  repo = "pull"  recipe = "y/pull"
// The org-bearing rule left the junk prefix standing because its unanchored
// host-word match started AT the last `github.com`, never eating the `x/` the
// code resolvers treat as dead weight (the anchored reading #317/#320 pin).
// The recipe now eats through the junk prefix, exactly like the code's
// orgs-page branch: one spelling, every surface.
const RESERVED_TAIL: readonly {
  readonly org: string;
  readonly raw: string;
  readonly repo: string;
}[] = [
  { org: "", raw: "x/github.com/users", repo: "" },
  { org: "", raw: "x/github.com/organizations", repo: "" },
  { org: "", raw: "acme/github.com/users", repo: "" },
  { org: "", raw: "https://x/github.com/users", repo: "" },
  { org: "", raw: "//x/github.com/users", repo: "" },
  // The deep form of the same paste: the code resolvers read `users/pull/1`
  // as a users page with a deep tail and answer the segment past `users/`.
  { org: "pull", raw: "y/github.com/users/pull/1", repo: "pull" },
  { org: "pull", raw: "https://y/github.com/users/pull/1", repo: "pull" },
  // The org-bearing spellings keep answering the org they name.
  { org: "acme", raw: "x/github.com/organizations/acme", repo: "acme" },
  { org: "acme", raw: "x/github.com/users/acme", repo: "acme" },
  // A hosted double host through a subdomain: the orgs page past the second
  // host word names its org on every code resolver; the recipe must agree.
  { org: "acme", raw: "codeload.github.com/github.com/orgs/acme", repo: "acme" },
  { org: "acme", raw: "gist.github.com/github.com/orgs/acme", repo: "acme" },
  // The colon-joined double host (the scp paste of a repo owned by `github.com`)
  // carrying an orgs page: the code resolvers answer the org past the FIRST
  // host word, the reading the #317/#320 corpus pins for the pair shapes.
  { org: "acme", raw: "github.com:github.com/orgs/acme", repo: "acme" },
];

describe("a reserved-word tail past a mid-string github.com host resolves on one spelling contract in every surface", () => {
  test("the code resolvers keep their pinned answers for every spelling", () => {
    for (const { org, raw, repo } of RESERVED_TAIL) {
      expect(orgOf(raw)).toBe(org);
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe(repo);
      expect([
        ...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw }),
      ]).toEqual(org === "" ? [] : [org]);
    }
  });

  test("every recipe copy answers the same value the code resolvers do", () => {
    for (const [name, recipe] of [
      ["prompt.md", promptRecipe],
      ["mint-token.ts", mintRecipe],
    ] as const) {
      for (const { raw, repo } of RESERVED_TAIL) {
        expect(runRecipe(recipe, raw)).toBe(repo);
      }
      expect(name).toBeDefined();
    }
  });
});
