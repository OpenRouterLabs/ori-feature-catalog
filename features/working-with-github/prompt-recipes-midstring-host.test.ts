// Regression (the recipe half of #314, companion to
// repo-string-midstring-host.test.ts): a github.com host word in the MIDDLE
// of a hostless path — `acme/github.com/widgets`, `x/github.com/y/z`,
// `owner/repo/github.com/tail`, `acme/api.github.com/widgets` — made the
// prompt's REPO= recipe (both copies) and mint-token.ts's header copy answer
// a DIFFERENT repo than every code resolver, the one-spelling contract the
// corpus pins. The recipe's generic `github.com[/:]` host strip was
// UNANCHORED, so it consumed the FIRST `github.com/` occurrence wherever it
// sat and welded the prefix onto the path:
//   `acme/github.com/widgets`      → `acme/widgets`   (code: `widgets`)
//   `x/github.com/y/z`             → `x/y`            (code: `y/z`)
//   `owner/re/github.com/tail`     → `owner/repo`     (code: `tail`)
//   `acme/api.github.com/widgets` → `acme/api.widgets` (code: `widgets`)
// The code resolvers' own `github.com`-keyed branches match the LAST
// occurrence (unanchored start, `$`-anchored end), the reading that treats a
// mid-string host word as a host; the recipe must agree. The fix makes the
// strip greedy (`^.*` ahead of the host word), so it consumes through the
// LAST `github.com[/:]` occurrence and leaves the same tail every code
// resolver derives. One spelling contract, recipe and resolvers (#314).
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

/** The mid-string host-word pastes — each must answer like the code resolvers. */
const MIDSTRING_SPELLINGS: readonly {
  readonly expected: string;
  readonly raw: string;
}[] = [
  { expected: "widgets", raw: "acme/github.com/widgets" },
  // #317: a spelling that GENUINELY STARTS with a scheme+host carries its
  // real host at the FRONT, so the pair past the FIRST, anchored host word
  // is the repo (`x/github.com`, `github.com/o`) — never the tail past a
  // LATER path segment that happens to read as a host word (`y/z`, `o/r`).
  // The org-side resolvers (`orgOf`, `resolveAllowedOrgs`) already read the
  // anchored host; the recipe and the repo-side resolvers must agree with
  // them on every hosted spelling.
  { expected: "y/z", raw: "x/github.com/y/z" },
  { expected: "tail", raw: "owner/repo/github.com/tail" },
  { expected: "widgets", raw: "acme/api.github.com/widgets" },
  { expected: "x/github.com", raw: "github.com/x/github.com/y/z" },
  { expected: "github.com/o", raw: "github.com/github.com/o/r" },
  { expected: "acme/github.com", raw: "https://github.com/acme/github.com/tree/main" },
];

/** Every previously-healthy spelling the recipe answered must stay byte-identical. */
const REGRESSION_SPELLINGS: readonly {
  readonly expected: string;
  readonly raw: string;
}[] = [
  { expected: "acme/widgets", raw: "acme/widgets" },
  { expected: "acme/widgets", raw: "https://github.com/acme/widgets" },
  { expected: "acme/widgets", raw: "github.com/acme/widgets" },
  { expected: "acme/widgets", raw: "git@github.com:acme/widgets" },
  { expected: "acme/widgets", raw: "ssh://git@github.com:22/acme/widgets" },
  { expected: "o/r", raw: "https://github.com/o/r/tree/main" },
  { expected: "acme", raw: "https://github.com/orgs/acme" },
  { expected: "", raw: "https://github.com/orgs" },
  { expected: "", raw: "https://github.com" },
  { expected: "", raw: "github.com:22" },
  { expected: "acme/widgets", raw: "https://www.github.com/acme/widgets" },
  { expected: "acme/widgets", raw: "https://gist.github.com/acme/widgets" },
  { expected: "acme/widgets", raw: "Gist.GitHub.com/acme/widgets" },
  { expected: "acme/widgets", raw: "www.github.com:acme/widgets" },
  { expected: "acme/widgets", raw: "https://www.github.com:22/acme/widgets" },
  { expected: "acme/widgets", raw: "HTTPS://gist.github.com/acme/widgets" },
  { expected: "acme/widgets", raw: "https://www.github.com/acme/widgets.git" },
  { expected: "acme/widgets", raw: "https://education.github.com/acme/widgets" },
  { expected: "o/r", raw: "https://codeload.github.com/o/r/tarball/main" },
  { expected: "o/r", raw: "https://www.github.com/o/r/tree/main" },
  { expected: "acme", raw: "https://gist.github.com/acme" },
  { expected: "", raw: "https://www.github.com" },
  { expected: "", raw: "www.github.com" },
  { expected: "acme/widgets", raw: "https://api.github.com/repos/acme/widgets" },
  { expected: "acme/widgets", raw: "api.github.com:acme/widgets" },
  { expected: "", raw: "api.github.com:443" },
  { expected: "", raw: "https://api.github.com" },
  { expected: "acme/widgets", raw: "https://raw.githubusercontent.com/acme/widgets/main/x.ts" },
  { expected: "acme/widgets", raw: "https://github.com/acme/widgets.git/" },
];

describe("the REPO= recipe resolves a mid-string github.com host word like the code resolvers", () => {
  for (const copy of recipeCopies) {
    test(`${copy.label}: every mid-string paste answers the code resolvers' pair`, () => {
      for (const { expected, raw } of MIDSTRING_SPELLINGS) {
        expect(runRecipe(copy.lines[0] ?? "", raw)).toBe(expected);
      }
    });

    test(`${copy.label}: every previously-healthy spelling is unchanged`, () => {
      for (const { expected, raw } of REGRESSION_SPELLINGS) {
        expect(runRecipe(copy.lines[0] ?? "", raw)).toBe(expected);
      }
    });
  }

  test("the code resolver agrees with the recipe on every mid-string paste", () => {
    for (const { expected, raw } of MIDSTRING_SPELLINGS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe(expected);
    }
  });
});