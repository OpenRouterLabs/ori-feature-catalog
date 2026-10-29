// Regression (companion to repo-string-subdomain-host.test.ts, the code half
// of #285): a github.com SUBDOMAIN host — `www.github.com`,
// `gist.github.com`, `codeload.github.com` (real hosts; the www form and every
// gist URL redirect to github.com, and codeload serves the very tarball URL
// the prompt's own download recipe builds) — is the same URL as
// `github.com`, and pre-fix the prompt's REPO= recipe (both copies) and
// mint-token.ts's header copy answered DEAD for every spelling in the class:
//   - the recipe's generic `github.com[/:]` strip consumed `github.com/`
//     INSIDE the subdomain host and welded the prefix onto the path —
//     `https://www.github.com/acme/widgets` → `https://www.acme/widgets`,
//     `https://gist.github.com/acme/widgets` → `https://gist.acme/widgets`,
//     `https://codeload.github.com/o/r/tarball/main` →
//     `https://codeload.o/r/tarball/main` — values every `repos/{repo}`
//     route 404s on, while the code resolvers answered the healthy pair;
//   - a bare-subdomain colon spelling (`www.github.com:acme/widgets`) and
//     the scp form (`git@www.github.com:acme/widgets`) welded the same way.
// The fix inserts ONE rule after the api block (so the api host keeps its
// own dedicated strip) and before the orgs rules: strip a one-label
// subdomain prefix from the host, exactly like the code resolvers' own
// subdomain strip. One spelling contract, recipe and resolvers (#285).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { resolveRepoFromEnv } from "@ori-monorepo/working-with-github/commit-api-core.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Every REPO= recipe copy in prompt.md (x2) and mint-token.ts (x1). */
const recipeCopies: readonly {
  readonly label: string;
  readonly lines: readonly string[];
}[] = (() => {
  const read = (file: string): readonly string[] =>
    [
      ...readFileSync(join(here, file), "utf-8").matchAll(
        /REPO=\$\(printf '%s' "\$GITHUB_REPO" \| sed -E '[^\n]*/gu
      ),
    ].map((match) => match[0] ?? "");
  const promptCopies = read("prompt.md");
  const mintCopies = read("scripts/mint-token.ts");
  expect(promptCopies.length).toBe(2);
  expect(mintCopies.length).toBe(1);
  return [
    { label: "prompt.md #1", lines: promptCopies },
    { label: "mint-token.ts", lines: mintCopies },
  ];
})();

const runRecipe = (line: string, spelling: string): string => {
  const recipe = line
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

/** The subdomain-host pastes — each must resolve like the plain host. */
const SUBDOMAIN_SPELLINGS: readonly {
  readonly expected: string;
  readonly raw: string;
}[] = [
  { expected: "acme/widgets", raw: "https://www.github.com/acme/widgets" },
  { expected: "acme/widgets", raw: "https://gist.github.com/acme/widgets" },
  { expected: "acme/widgets", raw: "Gist.GitHub.com/acme/widgets" },
  { expected: "acme/widgets", raw: "https://Www.GitHub.com/acme/widgets" },
  { expected: "acme/widgets", raw: "www.github.com:acme/widgets" },
  { expected: "acme/widgets", raw: "git@www.github.com:acme/widgets" },
  { expected: "acme/widgets", raw: "https://www.github.com:22/acme/widgets" },
  { expected: "acme/widgets", raw: "HTTPS://gist.github.com/acme/widgets" },
  { expected: "acme/widgets", raw: "https://www.github.com/acme/widgets.git" },
  { expected: "acme/widgets", raw: "https://education.github.com/acme/widgets" },
  { expected: "o/r", raw: "https://codeload.github.com/o/r/tarball/main" },
  { expected: "o/r", raw: "https://www.github.com/o/r/tree/main" },
  { expected: "acme", raw: "https://gist.github.com/acme" },
  { expected: "", raw: "https://www.github.com" },
  { expected: "", raw: "www.github.com" },
];

/** The api host must keep its own dedicated strip — never welded or eaten. */
const API_UNCHANGED_SPELLINGS: readonly {
  readonly expected: string;
  readonly raw: string;
}[] = [
  { expected: "acme/widgets", raw: "https://api.github.com/repos/acme/widgets" },
  { expected: "acme/widgets", raw: "api.github.com:acme/widgets" },
  { expected: "", raw: "api.github.com:443" },
  { expected: "", raw: "https://api.github.com" },
];

/** Every plain spelling the recipe already answered healthy must stay so. */
const REGRESSION_SPELLINGS: readonly {
  readonly expected: string;
  readonly raw: string;
}[] = [
  { expected: "acme/widgets", raw: "https://github.com/acme/widgets" },
  { expected: "acme/widgets", raw: "github.com/acme/widgets" },
  { expected: "acme/widgets", raw: "git@github.com:acme/widgets" },
  { expected: "acme/widgets", raw: "ssh://git@github.com:22/acme/widgets" },
  { expected: "acme/widgets", raw: "acme/widgets" },
  { expected: "o/r", raw: "https://github.com/o/r/tree/main" },
  { expected: "acme", raw: "https://github.com/orgs/acme" },
  { expected: "", raw: "https://github.com/orgs" },
  { expected: "", raw: "https://github.com" },
  { expected: "", raw: "github.com:22" },
];

describe("the REPO= recipe resolves a github.com subdomain host like the plain host", () => {
  for (const copy of recipeCopies) {
    test(`${copy.label}: every subdomain paste answers the healthy pair`, () => {
      for (const { expected, raw } of SUBDOMAIN_SPELLINGS) {
        expect(runRecipe(copy.lines[0] ?? "", raw)).toBe(expected);
      }
    });

    test(`${copy.label}: the api host keeps its own strip`, () => {
      for (const { expected, raw } of API_UNCHANGED_SPELLINGS) {
        expect(runRecipe(copy.lines[0] ?? "", raw)).toBe(expected);
      }
    });

    test(`${copy.label}: every previously-healthy spelling is unchanged`, () => {
      for (const { expected, raw } of REGRESSION_SPELLINGS) {
        expect(runRecipe(copy.lines[0] ?? "", raw)).toBe(expected);
      }
    });
  }

  test("the code resolver agrees with the recipe on every subdomain paste", () => {
    for (const { expected, raw } of SUBDOMAIN_SPELLINGS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe(expected);
    }
  });
});
