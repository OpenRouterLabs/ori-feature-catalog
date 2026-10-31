import { describe, expect, test } from "bun:test";
// Regression (the recipe half of #316, companion to
// repo-string-raw-midstring.test.ts): a `GITHUB_REPO` spelling whose
// raw.githubusercontent.com PATH contains a `github.com` segment-word —
// `raw.githubusercontent.com/acme/github.com/widgets`,
// `https://raw.githubusercontent.com/acme/github.com/widgets/main/x.ts` (a
// raw-file paste from a repo whose owner or repo name is literally
// `github.com`; GitHub repo names may carry dots) — made the REPO= recipe
// (both prompt.md copies and mint-token.ts's header copy) answer a DIFFERENT
// repo than every code resolver, the one-spelling contract the corpus pins
// (README: "every resolver in this feature tolerates the other spellings
// too").
//
// The recipe's raw block CAPTURED the first two path segments wholesale
// (`([^/]+/[^/]+)`), before any mid-string host-word normalization ran, so
// the mid-path `github.com` never read as a host word:
//   `raw…/acme/github.com/widgets`           → recipe `acme/github.com`
//                                            (code: `widgets`)
//   `raw…/github.com/o/r`                  → recipe `github.com/o`
//                                            (code: `o/r`)
//   `raw…/x/github.com/y/z`                 → recipe `x/github.com`
//                                            (code: `y/z`)
// The code resolvers strip the raw host and then apply the LAST-host-word
// reading the mid-string corpus pins (#314): a `github.com` inside the path
// is read as a host word, and `github.com/widgets` is an orgs-style page
// whose owner is the segment past it. The fix turns the capture rules into
// pure host-strip rules (host + optional port + one separator), so the tail
// flows on to the recipe's own generic `github.com[/:]` strip — the same
// last-host-word reading — and both surfaces agree on every spelling in the
// class. One spelling contract, recipe and resolvers (#316).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

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

/** The raw-host pastes whose path carries a `github.com` segment-word — each
 *  must answer the code resolvers' pair, never a captured-prefix pair. */
const RAW_MIDSTRING_SPELLINGS: readonly {
  readonly expected: string;
  readonly raw: string;
}[] = [
  { expected: "widgets", raw: "raw.githubusercontent.com/acme/github.com/widgets" },
  { expected: "widgets/main", raw: "https://raw.githubusercontent.com/acme/github.com/widgets/main/x.ts" },
  { expected: "o/r", raw: "raw.githubusercontent.com/github.com/o/r" },
  { expected: "y/z", raw: "raw.githubusercontent.com/x/github.com/y/z" },
  { expected: "widgets", raw: "git@raw.githubusercontent.com:acme/github.com/widgets" },
  { expected: "widgets", raw: "raw.githubusercontent.com:22/acme/github.com/widgets" },
  { expected: "o/r", raw: "https://raw.githubusercontent.com/github.com/o/r.git" },
];

/** The raw-host spellings the corpus already pins healthy — byte-identical. */
const RAW_PINNED_SPELLINGS: readonly {
  readonly expected: string;
  readonly raw: string;
}[] = [
  { expected: "acme/widgets", raw: "https://raw.githubusercontent.com/acme/widgets/main/x.ts" },
  { expected: "acme/widgets", raw: "raw.githubusercontent.com/acme/widgets/main/x.ts" },
  { expected: "acme/widgets", raw: "git@raw.githubusercontent.com:acme/widgets/main/x.ts" },
  { expected: "acme/widgets", raw: "ssh://git@raw.githubusercontent.com:acme/widgets/main/x.ts" },
  { expected: "acme/widgets", raw: "https://RAW.GitHubusercontent.com/acme/widgets/main/x.ts" },
  { expected: "acme/widgets", raw: "//raw.githubusercontent.com/acme/widgets/main/x.ts" },
  { expected: "acme/widgets", raw: "raw.githubusercontent.com/acme/widgets" },
  { expected: "acme/widgets", raw: "https://raw.githubusercontent.com/acme/widgets" },
  { expected: "acme/widgets", raw: "https://raw.githubusercontent.com:443/acme/widgets/main/x.ts" },
  { expected: "acme/widgets", raw: "raw.githubusercontent.com:22/acme/widgets" },
  { expected: "", raw: "https://raw.githubusercontent.com" },
  { expected: "", raw: "raw.githubusercontent.com" },
  { expected: "", raw: "git@raw.githubusercontent.com" },
  { expected: "", raw: "raw.githubusercontent.com:22" },
  { expected: "", raw: "https://raw.githubusercontent.com:443" },
  { expected: "", raw: "raw.githubusercontent.com/acme" },
  { expected: "", raw: "https://raw.githubusercontent.com/acme" },
  { expected: "", raw: "git@raw.githubusercontent.com:acme" },
];

describe("the REPO= recipe resolves a raw.githubusercontent.com paste carrying a mid-path github.com segment like the code resolvers", () => {
  for (const copy of recipeCopies) {
    test(`${copy.label}: every raw mid-string paste answers the code resolvers' pair`, () => {
      for (const { expected, raw } of RAW_MIDSTRING_SPELLINGS) {
        expect(runRecipe(copy.lines[0] ?? "", raw)).toBe(expected);
      }
    });

    test(`${copy.label}: every pinned raw spelling is unchanged`, () => {
      for (const { expected, raw } of RAW_PINNED_SPELLINGS) {
        expect(runRecipe(copy.lines[0] ?? "", raw)).toBe(expected);
      }
    });
  }

  test("the code resolvers agree with the pinned answers (corpus guard)", () => {
    for (const { expected, raw } of RAW_MIDSTRING_SPELLINGS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe(expected);
      expect(orgOf(raw)).toBe(expected.split("/")[0] ?? "");
      expect(
        Array.from(resolveAllowedOrgs(undefined, { GITHUB_REPO: raw }))
      ).toEqual([expected.split("/")[0] ?? ""]);
      expect(resolveConfigDirName({ GITHUB_REPO: raw })).toBe(
        expected.split("/")[1] ?? expected
      );
    }
    // The pinned raw corpus keeps its healthy answers on the code side too.
    for (const { expected, raw } of RAW_PINNED_SPELLINGS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe(expected);
    }
  });
});