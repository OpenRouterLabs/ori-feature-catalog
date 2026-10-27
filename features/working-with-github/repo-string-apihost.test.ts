// Regression (the api.github.com paste class): a REST-address copy-paste —
// `https://api.github.com/repos/acme/widgets` — is the URL shape this
// feature's own prompt teaches the operator to build and curl
// (prompt.md: "Read a file: `curl -sL -H 'Accept: …'
// https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={ref}`"),
// so pasting it back into `GITHUB_REPO` is a realistic operator action.
// Every one of the four repo-string resolvers derives a DEAD value from it,
// and the prompt's REPO= recipe derives a FIFTH, different dead value:
//
//   - `resolveRepoFromEnv` → "repos/acme" (`repos` is GitHub's REST host-path
//     word, never an owner login — `repos/repos/acme` answers 404, verified
//     live);
//   - `orgOf` → "repos" (a registry key no mint can ever derive from a real
//     repo string, silently bypassing a registered App);
//   - `resolveAllowedOrgs` → {"repos"} (a login no installation owner can
//     ever carry, so every mint fails closed with no hint the env var's
//     spelling was the cause);
//   - `resolveConfigDirName` → "acme" (a fourth answer, disagreeing with the
//     other three);
//   - the prompt's REPO= sed recipe → "https://api.repos/acme/widgets" (a
//     fifth answer — the `github.com[/:]` strip consumed `github.com/`
//     inside `api.github.com/`, welding `api.` onto `repos` — and no route
//     answers it either).
//
// Five disagreeing answers for one `GITHUB_REPO` spelling violates the
// README's one-spelling contract ("every resolver in this feature tolerates
// the other spellings too"), and all five are dead. The fix strips the
// `api.github.com` host word (the REST host this feature itself talks to)
// before the anchored branches, so `/repos/{owner}/{repo}[/tail]` resolves
// to its `owner/repo` pair exactly like the deep `github.com` paste class
// the sibling branches already close (#101/#159's class, reopened through
// the API host).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { orgOf, resolveConfigDirName } from "@ori-monorepo/working-with-github/gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

const here = dirname(fileURLToPath(import.meta.url));

const prompt = readFileSync(join(here, "prompt.md"), "utf-8");

const fences: readonly string[] = [
  ...prompt.matchAll(/```bash[^\n]*\n([\s\S]*?)```/g),
].map((match) => match[1] ?? "");

const isNormalizerLine = (line: string): boolean =>
  /^\s*REPO=\$\(printf '%s' "\$GITHUB_REPO" \| sed -E /.test(line);

/** The REPO= recipe, executed exactly as prompt.md prints it. */
const recipeRepoOf = (spelling: string): string => {
  const lines = fences.flatMap((fence) => fence.split("\n")).filter(isNormalizerLine);
  expect(lines.length).toBeGreaterThan(0);
  const recipe = (lines[0] ?? "").replace(/^REPO=\$\(printf '%s' "\$GITHUB_REPO" \| /u, "").replace(/\)$/u, "");
  const sed = recipe.replace(/^sed -E /u, "").split(/\s+/u).filter(Boolean);
  const argv = ["-E", ...sed.flatMap((expr) => ["-e", expr.replace(/^'|'$/gu, "")])];
  return execFileSync("sed", argv, {
    input: spelling,
  })
    .toString()
    .replace(/\n$/u, "");
};

const API_HOST_SPELLINGS: readonly string[] = [
  "https://api.github.com/repos/acme/widgets",
  "http://api.github.com/repos/acme/widgets",
  "api.github.com/repos/acme/widgets",
  "https://api.github.com/repos/acme/widgets/contents/README.md?ref=main",
  "https://api.github.com/repos/acme/widgets/tarball/main",
];

describe("an api.github.com REST paste resolves to its owner/repo like every other spelling", () => {
  test("resolveRepoFromEnv strips the api host and its /repos/ path word", () => {
    for (const spelling of API_HOST_SPELLINGS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe("acme/widgets");
    }
  });

  test("orgOf resolves to the owner, never the REST path word", () => {
    for (const spelling of API_HOST_SPELLINGS) {
      expect(orgOf(spelling)).toBe("acme");
    }
  });

  test("resolveAllowedOrgs keys the allowlist on the owner, so mints do not fail closed", () => {
    for (const spelling of API_HOST_SPELLINGS) {
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling })]).toEqual(["acme"]);
    }
  });

  test("resolveConfigDirName keys the same directory every other spelling keys", () => {
    for (const spelling of API_HOST_SPELLINGS) {
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe("widgets");
    }
  });

  test("the prompt's REPO= recipe agrees with the resolvers on the api-host paste", () => {
    for (const spelling of API_HOST_SPELLINGS) {
      expect(recipeRepoOf(spelling)).toBe("acme/widgets");
    }
  });

  test("a bare api host (no path) resolves to no owner/repo, like a bare github.com host", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: "https://api.github.com" })).toBe("");
    expect(orgOf("https://api.github.com")).toBe("");
    expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: "https://api.github.com" })]).toEqual([]);
  });
});
