import { describe, expect, test } from "bun:test";
// Regression: separator-adjacent whitespace BEFORE the separator —
// `acme /widgets`, `acme\t/o/r`, `https://github.com/acme /widgets` (the
// same #249/#257 separator-adjacent paste class the lookbehind strip
// already drops AFTER a separator) — belongs to no login or repo name, but
// only the after-separator strip ran. Pre-fix `orgOf` captured `"acme "`
// (space and all) as the owner and `resolveRepoFromEnv` kept
// `"acme /widgets"` whole, so:
//
//   orgOf("acme /widgets")                    // "acme " — a registry row
//                                            // keyed on it matches no mint's
//                                            // orgOf answer (COLLATE NOCASE
//                                            // does not ignore the space),
//                                            // silently falling back to the
//                                            // default App — reproduced
//                                            // end-to-end: registerApp
//                                            // persisted org "acme ",
//                                            // resolveApp(db, "acme",
//                                            // "default") answered null.
//   resolveRepoFromEnv({GITHUB_REPO: s})      // "acme /widgets" — every
//                                            // repos/{repo} route 404s, and
//                                            // gh --repo rejects it.
//
// while `resolveAllowedOrgs` (its per-entry trim) and `resolveConfigDirName`
// answered the healthy `acme`/`acme/widgets` — the resolvers disagreeing on
// one spelling, the README's one-spelling contract. The strip now drops the
// separator-adjacent whitespace on BOTH sides of the separator, and the
// prompt's REPO= recipe carries the same two rules as
// `s#([/:])[[:space:]]+#\1#g; s#[[:space:]]+([/:])#\1#g`.
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import {
  openGhAppRegistryDb,
  registerApp,
  resolveApp,
} from "./gh-app-registry.ts";
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

/** Whitespace riding on the owner side of the owner/repo separator. */
const SPACE_BEFORE_SEPARATOR: readonly string[] = [
  "acme /widgets",
  "acme\t/widgets",
  "acme / widgets",
  "acme  /widgets",
  "https://github.com/acme /widgets",
  "git@github.com:acme /widgets",
];

/** The same paste on the repo side — already healthy in the resolvers,
 *  and the recipe must agree (pre-fix it kept `acme/ widgets` whole). */
const SPACE_AFTER_SEPARATOR: readonly string[] = [
  "acme/ widgets",
  "acme/\twidgets",
  "https://github.com/acme/ widgets",
];

/** A space inside the scheme separator — the code resolvers already drop
 *  it (their after-separator strip sees the `//`); the recipe must agree. */
const SPACE_INSIDE_SCHEME: readonly string[] = [
  "https:// github.com/acme/widgets",
];

describe("whitespace adjacent to a path separator resolves like its de-padded spelling", () => {
  test("orgOf answers the login, never a space-suffixed registry key", () => {
    for (const spelling of SPACE_BEFORE_SEPARATOR) {
      expect(orgOf(spelling)).toBe("acme");
    }
  });

  test("resolveRepoFromEnv answers the pair, never an interior-space repo", () => {
    for (const spelling of [
      ...SPACE_BEFORE_SEPARATOR,
      ...SPACE_AFTER_SEPARATOR,
      ...SPACE_INSIDE_SCHEME,
    ]) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe(
        "acme/widgets"
      );
    }
  });

  test("the allowlist and the config dir answer the healthy keys", () => {
    for (const spelling of SPACE_BEFORE_SEPARATOR) {
      expect([
        ...resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling }),
      ]).toEqual(["acme"]);
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe("widgets");
    }
  });

  test("the prompt's REPO= recipe agrees with the resolvers", () => {
    for (const spelling of [
      ...SPACE_BEFORE_SEPARATOR,
      ...SPACE_AFTER_SEPARATOR,
      ...SPACE_INSIDE_SCHEME,
    ]) {
      expect(recipeRepoOf(spelling)).toBe("acme/widgets");
    }
  });

  test("a registered padded --org row is reachable by a healthy mint", async () => {
    // The end-to-end shape of the silent fallback: registerApp persists the
    // org it is given through orgOf, and the mint path looks the row up by
    // orgOf(targetRepo). Both sides go through orgOf, so the padded paste
    // and the healthy spelling must key the SAME row now.
    const dir = await mkdtemp(join(tmpdir(), "wwg-space-adjacent-"));
    process.env.GH_APP_REGISTRY_DIR = dir;
    const db = openGhAppRegistryDb();
    try {
      registerApp(db, {
        appIdKey: "TEAM_GH_APP_ID",
        org: "acme /widgets",
        privateKeyKey: "TEAM_GH_PRIVATE_KEY",
        purpose: "default",
      });
      // The mint side: orgOf("acme/widgets") = "acme" must find the row.
      expect(resolveApp(db, orgOf("acme/widgets"), "default")).toEqual({
        appIdKey: "TEAM_GH_APP_ID",
        privateKeyKey: "TEAM_GH_PRIVATE_KEY",
      });
    } finally {
      db.close();
      delete process.env.GH_APP_REGISTRY_DIR;
    }
  });
});
