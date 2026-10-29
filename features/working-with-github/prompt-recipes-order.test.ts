import { describe, expect, test } from "bun:test";
// Regression (the recipe's rule ORDER, not its rules): two paste classes the
// recipe answered dead while every code resolver answered healthy, both caused
// by the ORDER the recipe applied its own rules in — the rules themselves were
// already present, just sequenced wrong:
//
// 1. A PADDING-ONLY path segment — `github.com/acme/ /widgets`,
//    `https://github.com/acme/ /widgets` (one segment carrying nothing but
//    separator-adjacent whitespace, the #249/#255 paste class in its segment
//    form) — was answered `acme//widgets` by the recipe: the interior-slash
//    collapse ran BEFORE the separator-adjacent whitespace strips, so the
//    space-only segment blocked the collapse (`//` never became `/`) and the
//    padded pair flowed on past every anchored rule. The code resolvers strip
//    the whitespace first and answer `acme/widgets`
//    (repo-string-space-segment.test.ts pins them).
//
// 2. An UNSCHEMED api host with an explicit port and no repo path —
//    `api.github.com:443`, `API.GitHub.com:22/` (the REST host a curl echo or
//    an HTTP client prints bare, the #275/#282 port class in its host-only
//    form) — was answered `443` by the recipe: the api rules' optional port
//    group backtracked past the port to the bare `:` separator (the #186
//    class), the strip consumed `api.github.com:` and welded the PORT DIGITS
//    out as the value. The code resolvers strip the port FIRST and answer the
//    honest `""` (repo-string-apihost-case-port.test.ts pins them).
//
// Both are the one-spelling contract the recipe suites close (#238's class,
// reopened through the rule order): one GITHUB_REPO spelling, the recipe and
// every code resolver disagreeing. The fix reorders the recipe's own rules —
// the two separator-adjacent whitespace strips BEFORE the interior-slash
// collapse (the same order the code resolvers apply), and the port strip
// BEFORE the api block (ditto). No rule changes; every spelling the old order
// answered healthy keeps its byte-identical answer (the corpus guard below).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** The padding-only-segment pastes — each must collapse like the resolvers do. */
const PADDED_SEGMENT_SPELLINGS: readonly {
  readonly expected: string;
  readonly raw: string;
}[] = [
  { expected: "acme/widgets", raw: "github.com/acme/ /widgets" },
  { expected: "acme/widgets", raw: "https://github.com/acme/ /widgets" },
  { expected: "acme/widgets", raw: "git@github.com:acme/ /widgets" },
  { expected: "acme/widgets", raw: "ssh://git@github.com:22/acme/ /widgets" },
  { expected: "acme/widgets", raw: "GitHub.com/acme/ /widgets" },
  { expected: "acme/widgets", raw: "github.com:22/acme/ /widgets" },
];

/** The bare ported api-host pastes — each must empty like the resolvers do. */
const BARE_PORTED_API_HOST_SPELLINGS: readonly {
  readonly expected: string;
  readonly raw: string;
}[] = [
  { expected: "", raw: "api.github.com:443" },
  { expected: "", raw: "api.github.com:22/" },
  { expected: "", raw: "API.GitHub.com:443" },
  { expected: "", raw: "https://api.github.com:443" },
  { expected: "", raw: "git@api.github.com:443" },
  { expected: "", raw: "ssh://api.github.com:22" },
];

describe("the REPO= recipe applies its rules in the resolver order", () => {
  for (const copy of recipeCopies) {
    test(
      `${copy.label}: a padding-only path segment collapses like the resolvers`,
      () => {
        for (const { expected, raw } of PADDED_SEGMENT_SPELLINGS) {
          expect(runRecipe(copy.lines[0] ?? "", raw)).toBe(expected);
        }
      }
    );

    test(
      `${copy.label}: a bare ported api host empties like the resolvers`,
      () => {
        for (const { expected, raw } of BARE_PORTED_API_HOST_SPELLINGS) {
          expect(runRecipe(copy.lines[0] ?? "", raw)).toBe(expected);
        }
      }
    );

    test(`${copy.label}: the ported api host with a repo path keeps its pinned answer`, () => {
      // The ported api-host + path spellings the #275/#282 rules already
      // answer healthy — the reorder must not regress them.
      expect(
        runRecipe(copy.lines[0] ?? "", "https://api.github.com:443/repos/acme/widgets")
      ).toBe("acme/widgets");
      expect(
        runRecipe(copy.lines[0] ?? "", "api.github.com:443/repos/acme/widgets")
      ).toBe("acme/widgets");
      expect(
        runRecipe(copy.lines[0] ?? "", "API.GitHub.com:443/orgs/acme")
      ).toBe("acme");
    });

    test(`${copy.label}: the unpadded interior-slash pastes keep their pinned answers (corpus guard)`, () => {
      // The interior-double spellings the collapse rule already answers — the
      // reorder must not regress them.
      expect(runRecipe(copy.lines[0] ?? "", "github.com//acme/widgets")).toBe(
        "acme/widgets"
      );
      expect(runRecipe(copy.lines[0] ?? "", "acme//widgets")).toBe(
        "acme/widgets"
      );
      // The separator-adjacent whitespace shapes that were already stripped —
      // now they run before the collapse, and their answers are unchanged.
      expect(runRecipe(copy.lines[0] ?? "", "/ acme/widgets")).toBe(
        "acme/widgets"
      );
      expect(runRecipe(copy.lines[0] ?? "", "github.com/ acme/widgets")).toBe(
        "acme/widgets"
      );
      expect(runRecipe(copy.lines[0] ?? "", "acme /widgets")).toBe(
        "acme/widgets"
      );
    });
  }
});
