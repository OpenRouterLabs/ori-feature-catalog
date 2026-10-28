import { describe, expect, test } from "bun:test";
// Regression (the api.github.com paste class, reopened through an explicit
// PORT): a REST-address copy-paste with a port on the api host —
// `https://api.github.com:443/repos/acme/widgets`,
// `https://api.github.com:443/orgs/acme`,
// `https://api.github.com:443/users/acme` (an `https://…:443/` spelling a
// browser or an HTTP client echo of the canonical endpoint produces) — is
// the same URL as the unported form, and EVERY CODE resolver already answers
// it healthy (repo-string-apihost.test.ts pins the unported spellings; the
// port strip consumes the lowercase `github.com` inside `api.github.com` and
// the api-host strip then sees the plain host). But the prompt's REPO= sed
// recipe (and mint-token.ts's header copy) still derive a DEAD, WELDED
// value: the recipe's api rules are anchored on the host word ending at a
// separator (`[Cc][Oo][Mm](?:\/|$)`-style), so a port makes them miss, and
// the later generic `github.com[/:]` strip then consumes `github.com:` INSIDE
// `api.github.com:443`, welding `api.` onto the path that follows:
//
//   recipe("https://api.github.com:443/repos/acme/widgets") → "https://api.repos/acme/widgets"
//   recipe("https://api.github.com:443/orgs/acme")          → "https://api.acme"
//   code("https://api.github.com:443/repos/acme/widgets")   → "acme/widgets"
//
// One spelling, the recipe and all four resolvers disagreeing — the exact
// one-spelling contract the recipe suites close (#238's class, reopened
// through the port). A bare ported api host (`https://api.github.com:443`)
// is also pinned: the recipe leaves the host string with its port behind
// (`https://api.github.com`) where the code resolvers answer the honest "".
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

/** The ported api-host REST pastes — each must resolve like its unported form. */
const PORTED_API_HOST_SPELLINGS: readonly {
  readonly expected: string;
  readonly raw: string;
}[] = [
  { expected: "acme/widgets", raw: "https://api.github.com:443/repos/acme/widgets" },
  { expected: "acme", raw: "https://api.github.com:443/orgs/acme" },
  { expected: "acme", raw: "https://api.github.com:443/users/acme" },
  { expected: "acme/widgets", raw: "api.github.com:443/repos/acme/widgets" },
  { expected: "acme", raw: "api.github.com:443/orgs/acme" },
  { expected: "acme", raw: "api.github.com:443/users/acme" },
];

describe("the REPO= recipe resolves a ported api.github.com paste like the resolvers", () => {
  for (const copy of recipeCopies) {
    test(`${copy.label}: a ported api host answers the same value as the unported form`, () => {
      for (const { expected, raw } of PORTED_API_HOST_SPELLINGS) {
        expect(runRecipe(copy.lines[0] ?? "", raw)).toBe(expected);
      }
    });
  }

  test("a bare ported api host normalizes to nothing, like the resolvers", () => {
    for (const copy of recipeCopies) {
      expect(runRecipe(copy.lines[0] ?? "", "https://api.github.com:443")).toBe("");
    }
  });

  test("the unported api spellings keep their pinned answers (corpus guard)", () => {
    for (const copy of recipeCopies) {
      expect(
        runRecipe(copy.lines[0] ?? "", "https://api.github.com/repos/acme/widgets")
      ).toBe("acme/widgets");
      expect(
        runRecipe(copy.lines[0] ?? "", "https://api.github.com/orgs/acme")
      ).toBe("acme");
    }
  });
});
