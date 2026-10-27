// Regression (the api.github.com paste class, reopened through the HOST WORD's
// case and through USER-INFO before the api host): a REST-address copy-paste
// whose host kept the address bar's capitalization — `API.GitHub.com/…`,
// `https://Api.github.com/…` — or that carried a user-info word before the
// api host — `git@api.github.com/repos/…`, `https://git@api.github.com/repos/…`
// (a `git remote -v` / scp-style spelling of the REST host this feature's own
// prompt teaches the operator to curl) — is the SAME URL as the lowercase,
// user-less form (hosts are case-insensitive, RFC 3986 §3.2.2; the user-info
// component names no owner), and the sibling github.com resolvers already
// tolerate BOTH dimensions for the plain host (`repo-string-hostcase.test.ts`,
// `repo-string-userinfo.test.ts`). But the api-host strip was keyed on a
// case-SENSITIVE, user-LESS literal — `api\.github\.com` right after the
// optional scheme — so every one of the four repo-string resolvers fell its
// api branch and answered a DEAD value, and no two agreed:
//
//   - `resolveRepoFromEnv` → "API.GitHub.com/repos" / "repos/acme" (a
//     `repos/{repo}` route no GitHub route answers — `repos` is the REST
//     host-path word, never an owner login);
//   - `orgOf` → "API.GitHub.com" (a registry key no mint can ever derive,
//     silently bypassing a registered App);
//   - `resolveAllowedOrgs` → {"api.github.com"} for the case-variant — a
//     LOWER-CASED host word no installation owner can ever carry, so EVERY
//     mint failed closed with no hint the env var's spelling was the cause —
//     and {"git@api.github.com"} for the user-info form (the raw string,
//     another login no installation can own);
//   - `resolveConfigDirName` → "API.GitHub.com" (a fourth answer, silently
//     migrating the registry/cache DB).
//
// Four disagreeing answers for one `GITHUB_REPO` spelling violates the
// README's one-spelling contract, and all four are dead. The fix gives the
// api-host strip the same two dimensions the github.com host strips already
// have: case-paired host letters (`[Aa][Pp][Ii]\.[Gg]…[Mm]`) and an optional
// user-info word before the host (dropped with it — a user name is never an
// owner). Every lowercase, user-less spelling keeps its byte-identical
// answer; the case/user-info variants join the SAME answers.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
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

/** The HOST-CASE variants of the api host — every one the same URL as its
 *  lowercase form, and every one already answered `acme/widgets` by the
 *  resolvers' sibling github.com branches being case-folded (the #159/#169
 *  corpus) while the api branch was not. */
const API_HOST_CASE_SPELLINGS: readonly string[] = [
  "API.GitHub.com/repos/acme/widgets",
  "Api.GitHub.com/repos/acme/widgets",
  "API.GITHUB.COM/repos/acme/widgets",
  "https://Api.github.com/repos/acme/widgets",
  "api.GitHub.com/users/acme",
  "API.GitHub.com/orgs/acme",
];

/** The USER-INFO variants — a user word before the api host, the scp/ssh
 *  shape every github.com resolver already tolerates
 *  (repo-string-userinfo.test.ts pins the code side for the plain host). */
const API_HOST_USERINFO_SPELLINGS: readonly string[] = [
  "git@api.github.com/repos/acme/widgets",
  "https://git@api.github.com/repos/acme/widgets",
  "ssh://git@api.github.com/repos/acme/widgets",
  "deploy@api.github.com/users/acme",
  "bob@api.github.com/orgs/acme",
];

describe("an api.github.com paste with a case-variant host or a user-info word resolves like its plain form", () => {
  test("resolveRepoFromEnv answers owner/repo, never the host word or repos/{owner}", () => {
    for (const spelling of API_HOST_CASE_SPELLINGS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe(
        spelling.includes("/users/") || spelling.includes("/orgs/") ? "acme" : "acme/widgets"
      );
    }
    for (const spelling of API_HOST_USERINFO_SPELLINGS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe(
        spelling.includes("/users/") || spelling.includes("/orgs/") ? "acme" : "acme/widgets"
      );
    }
  });

  test("orgOf answers the owner, never the host word nor the REST path word", () => {
    for (const spelling of [...API_HOST_CASE_SPELLINGS, ...API_HOST_USERINFO_SPELLINGS]) {
      expect(orgOf(spelling)).toBe("acme");
    }
  });

  test("resolveAllowedOrgs keys the allowlist on the owner, so mints do not fail closed", () => {
    for (const spelling of [...API_HOST_CASE_SPELLINGS, ...API_HOST_USERINFO_SPELLINGS]) {
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling })]).toEqual(["acme"]);
    }
  });

  test("resolveConfigDirName keys the same directory every other spelling keys", () => {
    for (const spelling of [...API_HOST_CASE_SPELLINGS, ...API_HOST_USERINFO_SPELLINGS]) {
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe(
        spelling.includes("/users/") || spelling.includes("/orgs/") ? "acme" : "widgets"
      );
    }
  });

  test("the lowercase, user-less api spellings keep their byte-identical answers", () => {
    for (const spelling of [
      "https://api.github.com/repos/acme/widgets",
      "api.github.com/repos/acme/widgets",
      "https://api.github.com/users/acme",
      "https://api.github.com",
    ]) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe(
        spelling === "https://api.github.com" ? "" : spelling.includes("/users/") ? "acme" : "acme/widgets"
      );
      expect(orgOf(spelling)).toBe(
        spelling === "https://api.github.com" ? "" : "acme"
      );
    }
  });

  test("a bare case-variant or user-info api host names no owner, like the bare lowercase host", () => {
    for (const spelling of ["API.GitHub.com", "git@api.github.com", "https://Api.github.com"]) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe("");
      expect(orgOf(spelling)).toBe("");
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling })]).toEqual([]);
      expect(resolveConfigDirName({ GITHUB_REPO: spelling, INTERN_NAME: "" })).toBe("intern");
    }
  });
});
