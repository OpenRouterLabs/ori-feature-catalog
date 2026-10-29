import { describe, expect, test } from "bun:test";
// Regression (the api.github.com paste class, reopened through a COLON host
// separator): the recipe's api rules anchor the host word at a SLASH —
// `…[Cc][Oo][Mm](:[0-9]+)?/` — so a REST-address copy-paste whose host rides
// a COLON into the path (`API.GitHub.com:acme/widgets`,
// `https://api.github.com:/acme/widgets` — the scp/ssh host:tail shape a
// `git remote -v` copy-paste produces for any host, an empty-port paste, and
// the port+colon double `HTTPS://API.GitHub.com:22:acme/widgets`) makes every
// api rule miss, and the later generic `github.com[/:]` strip then consumes
// `github.com:` INSIDE the api host, welding the `api.` prefix onto the path
// that follows:
//
//   recipe("API.GitHub.com:acme/widgets")          → "API.acme/widgets"
//   recipe("https://api.github.com:acme/widgets")  → "https://api.acme/widgets"
//   code("https://api.github.com:acme/widgets")    → "acme/widgets"
//
// One spelling, the recipe and the code resolvers disagreeing — the exact
// one-spelling contract the recipe suites close (#238/#276's class, reopened
// through the separator). The fix makes every api rule's separator a
// `[/:]+` run, the same separator set the code resolvers' api strips now
// accept. Every slash-separated spelling keeps its byte-identical answer
// (prompt-recipes-apiport.test.ts and prompt-recipes-apirest-users-tail.test.ts
// pin those).
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

/** The colon-separated api-host pastes — each must resolve like its slash form. */
const COLON_API_HOST_SPELLINGS: readonly {
  readonly expected: string;
  readonly raw: string;
}[] = [
  { expected: "acme/widgets", raw: "API.GitHub.com:acme/widgets" },
  { expected: "acme/widgets", raw: "https://api.github.com:acme/widgets" },
  { expected: "acme/widgets", raw: "https://api.github.com:/acme/widgets" },
  { expected: "acme/widgets", raw: "HTTPS://API.GitHub.com:22:acme/widgets" },
  { expected: "acme", raw: "API.GitHub.com:acme" },
  { expected: "acme", raw: "https://api.github.com:acme" },
];

describe("the REPO= recipe resolves a colon-separated api.github.com paste like the resolvers", () => {
  for (const copy of recipeCopies) {
    test(`${copy.label}: a colon-separated api host answers the same value as its slash form`, () => {
      for (const { expected, raw } of COLON_API_HOST_SPELLINGS) {
        expect(runRecipe(copy.lines[0] ?? "", raw)).toBe(expected);
      }
    });
  }

  test("the slash-separated api spellings keep their pinned answers (corpus guard)", () => {
    for (const copy of recipeCopies) {
      expect(
        runRecipe(copy.lines[0] ?? "", "https://api.github.com/repos/acme/widgets")
      ).toBe("acme/widgets");
      expect(
        runRecipe(copy.lines[0] ?? "", "https://api.github.com:443/repos/acme/widgets")
      ).toBe("acme/widgets");
      expect(
        runRecipe(copy.lines[0] ?? "", "https://api.github.com/users/acme")
      ).toBe("acme");
    }
  });
});
