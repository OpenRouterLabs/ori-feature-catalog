import { describe, expect, test } from "bun:test";
// Regression (the #249/#257 separator-adjacent whitespace class, reopened
// through the HOST word's capitalization): a copy-paste whose host kept the
// address bar's capitalization AND carried separator-adjacent whitespace
// before the first path separator — `https://GitHub.com /acme/widgets`,
// `GitHub.com /acme`, `GitHub.com :acme`, `git@GitHub.com :acme/widgets` —
// is the same URL as its lowercase form (`https://github.com /acme/widgets`
// and friends are pinned healthy by repo-string-space-adjacent.test.ts), and
// hosts are case-insensitive (RFC 3986 §3.2.2), so every real client accepts
// the mixed-case host. But `orgOf` and `resolveRepoFromEnv` lower-case the
// host BEFORE the separator-adjacent whitespace strips run: the case-lower
// pre-strip keys on a `github.com`-anchored lookahead that must see a
// separator RIGHT after the host word, the intervening space defeats it, the
// host keeps its case, every anchored lowercase `github.com` branch below
// misses, and the raw junk string flows on whole as the "org"/"repo" —
// while `resolveAllowedOrgs` and `resolveConfigDirName` (which strip the
// whitespace FIRST) and the prompt's REPO= recipe answer the healthy values.
//
//   - `orgOf("https://GitHub.com /acme/widgets")` → the whole URL — a
//     registry key no mint can ever derive, silently bypassing a registered
//     App;
//   - `resolveRepoFromEnv` → the whole URL — every `repos/{repo}` route
//     404s and `gh --repo` rejects it;
//   - `resolveConfigDirName` → "widgets" (healthy), `resolveAllowedOrgs` →
//     {"acme"} (healthy), the recipe → "acme/widgets" (healthy).
//
// Four resolvers, three healthy and two dead answers for one spelling —
// the README's one-spelling contract. The fix drops the separator-adjacent
// whitespace BEFORE the case-lower pre-strip in both resolvers, exactly the
// order `resolveAllowedOrgs`/`resolveConfigDirName` already apply.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  const lines = fences
    .flatMap((fence) => fence.split("\n"))
    .filter(isNormalizerLine);
  expect(lines.length).toBeGreaterThan(0);
  const recipe = (lines[0] ?? "")
    .replace(/^REPO=\$\(printf '%s' "\$GITHUB_REPO" \| /u, "")
    .replace(/\)$/u, "");
  const sed = recipe.replace(/^sed -E /u, "").split(/\s+/u).filter(Boolean);
  const argv = [
    "-E",
    ...sed.flatMap((expr) => ["-e", expr.replace(/^'|'$/gu, "")]),
  ];
  return execFileSync("sed", argv, {
    input: spelling,
  })
    .toString()
    .replace(/\n$/u, "");
};

/** Host-case spellings carrying whitespace before the first separator. */
const HOSTCASE_SPACE_BEFORE_SEPARATOR: readonly {
  readonly expectedDir: string;
  readonly expectedOrg: string;
  readonly expectedRepo: string;
  readonly raw: string;
}[] = [
  {
    expectedDir: "widgets",
    expectedOrg: "acme",
    expectedRepo: "acme/widgets",
    raw: "https://GitHub.com /acme/widgets",
  },
  {
    expectedDir: "acme",
    expectedOrg: "acme",
    expectedRepo: "acme",
    raw: "GitHub.com /acme",
  },
  {
    expectedDir: "acme",
    expectedOrg: "acme",
    expectedRepo: "acme",
    raw: "GitHub.com :acme",
  },
  {
    expectedDir: "widgets",
    expectedOrg: "acme",
    expectedRepo: "acme/widgets",
    raw: "git@GitHub.com :acme/widgets",
  },
];

describe("a host-case spelling with separator-adjacent whitespace resolves like its lowercase form", () => {
  test("orgOf answers the owner, never the raw junk string", () => {
    for (const { expectedOrg, raw } of HOSTCASE_SPACE_BEFORE_SEPARATOR) {
      expect(orgOf(raw)).toBe(expectedOrg);
    }
  });

  test("resolveRepoFromEnv answers owner/repo, never the whole URL", () => {
    for (const { expectedRepo, raw } of HOSTCASE_SPACE_BEFORE_SEPARATOR) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe(expectedRepo);
    }
  });

  test("the allowlist and the config dir keep their healthy answers", () => {
    for (const { expectedDir, expectedOrg, raw } of HOSTCASE_SPACE_BEFORE_SEPARATOR) {
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw })]).toEqual([
        expectedOrg,
      ]);
      expect(resolveConfigDirName({ GITHUB_REPO: raw })).toBe(expectedDir);
    }
  });

  test("the prompt's REPO= recipe agrees (pinned healthy already)", () => {
    for (const { expectedRepo, raw } of HOSTCASE_SPACE_BEFORE_SEPARATOR) {
      expect(recipeRepoOf(raw)).toBe(expectedRepo);
    }
  });

  test("the lowercase forms of the same shapes stay byte-identical", () => {
    expect(orgOf("https://github.com /acme/widgets")).toBe("acme");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "https://github.com /acme/widgets" })).toBe(
      "acme/widgets"
    );
    expect(orgOf("github.com :acme")).toBe("acme");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "github.com :acme" })).toBe("acme");
  });

  test("a host-case spelling with NO separator-adjacent whitespace stays healthy", () => {
    expect(orgOf("https://GitHub.com/acme/widgets")).toBe("acme");
    expect(
      resolveRepoFromEnv({ GITHUB_REPO: "https://GitHub.com/acme/widgets" })
    ).toBe("acme/widgets");
  });
});
