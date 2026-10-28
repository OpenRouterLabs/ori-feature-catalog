// Regression (companion to prompt-recipes.test.ts / repo-string-userspage.test.ts): the
// api.github.com REST paste classes whose PATH extends past the route words —
// `https://api.github.com/users/<login>/<tail>` (a user's sub-resource route:
// `/users/{login}/followers`, `/users/{login}/repos`, …) — resolve to the LOGIN,
// never a fake `login/<tail>` owner/repo pair. The users-page fix (#237's corpus) only
// covered the exact `/users/<login>` shape: the recipe's api `users/` strip rule dropped
// the host + the `users/` path word but left `<login>/<tail>` standing, so the anchored
// two-segment rule captured `acme/followers` as a fake owner/repo pair — while all four
// code resolvers answer the LOGIN (`acme`), the exact answers #237 pinned for the
// users-page class. One spelling contract, five surfaces: the recipe must agree.
//
// The same corpus pins the DOUBLED-separator api classes:
//   - `https://api.github.com//<path>` — an interior doubled slash past the api host —
//     the recipe's interior-collapse rule ran AFTER the api strips, so the anchored
//     rules saw `/<path>` and keyed on the path word (`repos`/`users` as the "owner").
//     The code resolvers collapse interior doubles BEFORE every anchored branch
//     (#224/#255's order), so they answer the healthy pair. The recipe now collapses
//     first, same order.
//   - `github.com[/:]+<path>` with a doubled separator (`git@github.com::acme`,
//     `https://github.com:/acme`) — the recipe's generic host strip consumed every
//     separator greedily (`[/:]+`), answering `acme` while every code resolver
//     strips ONE separator and keeps the malformed tail (`:acme`, a dead key both
//     sides agree is dead — the contract is that they agree, not which one is pretty).
//     The recipe now strips a single `[/:]`, exactly like the resolvers.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { orgOf, resolveConfigDirName } from "@ori-monorepo/working-with-github/gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

const promptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "prompt.md"
);
const prompt = readFileSync(promptPath, "utf-8");

const fences: readonly string[] = [
  ...prompt.matchAll(/```bash[^\n]*\n([\s\S]*?)```/g),
].map((match) => match[1] ?? "");

const isNormalizerLine = (line: string): boolean =>
  /^\s*REPO=\$\(printf '%s' "\$GITHUB_REPO" \| sed -E /.test(line);

/** The REPO= recipe, executed exactly as prompt.md prints it. */
const recipeRepoOf = (spelling: string): string => {
  const line = fences
    .join("\n")
    .split("\n")
    .find((candidate) => isNormalizerLine(candidate))
    ?.trim();
  expect(line).toBeDefined();
  if (line === undefined) {
    return "";
  }
  const output = execFileSync("bash", ["-c", `${line}\nprintf '%s' "$REPO"`], {
    encoding: "utf-8",
    env: { ...process.env, GITHUB_REPO: spelling },
  });
  return output;
};

/** The users-REST sub-resource pastes: `<api-host>/users/<login>[/<tail>]`. */
const USERS_TAIL_SPELLINGS: readonly string[] = [
  "https://api.github.com/users/acme/followers",
  "api.github.com/users/acme/followers",
  "https://api.github.com/users/acme/repos",
  "https://api.github.com/users/acme/sub/rel/followers",
  "https://api.github.com/users/acme/followers?per_page=1",
];

/** The doubled-separator pastes past the api and web hosts. */
const DOUBLED_SEPARATOR_SPELLINGS: readonly (readonly [
  string,
  string,
])[] = [
  ["https://api.github.com//repos/acme/widgets", "acme/widgets"],
  ["https://api.github.com//users/acme", "acme"],
  ["api.github.com//repos/acme/widgets", "acme/widgets"],
  ["git@github.com::acme", ":acme"],
  ["git@github.com::acme/widgets", ":acme/widgets"],
  ["github.com::acme", ":acme"],
  ["https://github.com::acme/widgets", ":acme/widgets"],
];

describe("the REPO= recipe agrees with the resolvers on the api REST sub-resource pastes", () => {
  test("resolveRepoFromEnv answers the login a users sub-resource route names", () => {
    for (const spelling of USERS_TAIL_SPELLINGS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe("acme");
    }
  });

  test("orgOf, the allowlist, and the config dir answer the login too", () => {
    for (const spelling of USERS_TAIL_SPELLINGS) {
      expect(orgOf(spelling)).toBe("acme");
      expect([
        ...resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling }),
      ]).toEqual(["acme"]);
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe("acme");
    }
  });

  test("the recipe answers the login, never the fake login/<tail> pair", () => {
    for (const spelling of USERS_TAIL_SPELLINGS) {
      expect(recipeRepoOf(spelling)).toBe("acme");
    }
  });

  test("the recipe collapses an interior double past the api host like the resolvers", () => {
    for (const [spelling, expected] of DOUBLED_SEPARATOR_SPELLINGS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe(expected);
      expect(recipeRepoOf(spelling)).toBe(expected);
    }
  });
});