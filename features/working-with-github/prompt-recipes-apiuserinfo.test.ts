import { describe, expect, test } from "bun:test";
// Regression (the api.github.com paste class, reopened through a USER-INFO
// prefix): every code resolver has tolerated a `git@`-style user word before
// the api host since #247 — `git@api.github.com/repos/acme/widgets`,
// `https://git@api.github.com/repos/acme/widgets` (a deploy-key or CI remote
// spelling `git remote -v` produces) — via its `(?:[^@\/\s]+@)?` group, and
// repo-string-apihost-case-userinfo.test.ts pins those answers. The prompt's
// REPO= sed recipe (and mint-token.ts's header copy) never did: its api rules
// anchor `^[scheme://]API…` / `^API…` with NO user-info group, so the user
// word defeats them and the later generic `github.com[/:]` strip consumes
// `github.com/` INSIDE the api host, welding the residue onto the path:
//
//   recipe("git@api.github.com/repos/acme/widgets")        → "git@api.repos/acme"
//   recipe("https://git@api.github.com/repos/acme/widgets") → "https://git@api.repos/acme/widgets"
//   code("git@api.github.com/repos/acme/widgets")        → "acme/widgets"
//
// One spelling, the recipe and every code resolver disagreeing — the exact
// one-spelling contract the recipe suites close (#238/#276's class, reopened
// through the user-info word). The fix gives every api rule the same optional
// `([^@[:space:]]+@)?` user-info group the code resolvers carry. Every
// user-info-free spelling keeps its byte-identical answer.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Every REPO= recipe copy in prompt.md (x2) and mint-token.ts (x1). */
const recipeCopies: readonly { readonly label: string; readonly lines: readonly string[] }[] = (
  () => {
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
  }
)();

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

/** The user-info api-host pastes — each must resolve like its bare form. */
const USERINFO_API_HOST_SPELLINGS: readonly {
  readonly expected: string;
  readonly raw: string;
}[] = [
  { expected: "acme/widgets", raw: "git@api.github.com/repos/acme/widgets" },
  { expected: "acme/widgets", raw: "https://git@api.github.com/repos/acme/widgets" },
  { expected: "acme/widgets", raw: "git@api.github.com:443/repos/acme/widgets" },
  { expected: "acme", raw: "git@api.github.com/users/acme" },
  { expected: "acme", raw: "git@api.github.com/orgs/acme" },
  { expected: "", raw: "git@api.github.com" },
];

describe("the REPO= recipe resolves a user-info api.github.com paste like the resolvers", () => {
  for (const copy of recipeCopies) {
    test(`${copy.label}: a user-info api host answers the same value as its bare form`, () => {
      for (const { expected, raw } of USERINFO_API_HOST_SPELLINGS) {
        expect(runRecipe(copy.lines[0] ?? "", raw)).toBe(expected);
      }
    });
  }

  test("the user-info-free api spellings keep their pinned answers (corpus guard)", () => {
    for (const copy of recipeCopies) {
      expect(
        runRecipe(copy.lines[0] ?? "", "https://api.github.com/repos/acme/widgets")
      ).toBe("acme/widgets");
      expect(
        runRecipe(copy.lines[0] ?? "", "https://api.github.com:443/repos/acme/widgets")
      ).toBe("acme/widgets");
      expect(
        runRecipe(copy.lines[0] ?? "", "https://API.GitHub.com:/acme/widgets")
      ).toBe("acme/widgets");
    }
  });
});
