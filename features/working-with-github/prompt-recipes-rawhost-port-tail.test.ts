import { describe, expect, test } from "bun:test";
// A ported raw.githubusercontent.com paste with a SINGLE segment after the
// host — `raw.githubusercontent.com:443/acme`,
// `https://raw.githubusercontent.com:22/acme` (the `git remote -v` /
// address-bar paste class the raw corpus already covers for FILE paths) —
// is the degenerate tail of the shape repo-string-rawhost-port.test.ts
// pins for the CODE resolvers: a raw host's documented path scheme is
// `/<owner>/<repo>/<ref>/<path>`, so a single segment past the host names
// NO repo, and every code resolver answers the honest "" (verified live
// against resolveRepoFromEnv and orgOf). Pre-fix the prompt's `REPO=`
// recipe answered the FAKE owner/repo pair `443/acme` for it: the
// recipe's github.com port strip keys on the literal `github.com` host
// word, which raw.githubusercontent.com does not contain, so the port
// survived; the raw-host branch then captured the PORT DIGITS as the
// owner and the single segment as the repo — `$REPO` interpolated a pair
// no route answers (`gh --repo 443/acme`, `repos/443/acme` — 404, a
// port number is never a login) while every code resolver answered "" —
// the exact #186 "port digits must never become the owner segment"
// class, reopened through the raw host's degenerate tail. The ported
// FILE spellings (two segments after the host) already resolve healthy
// through both surfaces; this is the one-segment gap.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { orgOf } from "./gh-app-registry.ts";
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
    ].map((match) => (match[0] ?? ""));
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

/** The ported raw-host spellings with a single segment after the host. */
const RAW_PORTED_SINGLE_SEGMENT: readonly string[] = [
  "raw.githubusercontent.com:443/acme",
  "https://raw.githubusercontent.com:443/acme",
  "raw.githubusercontent.com:22/acme",
  "git@raw.githubusercontent.com:443/acme",
  "RAW.githubusercontent.com:443/acme",
];

describe("a ported raw host with a single segment past it resolves to no repo, like every resolver", () => {
  test("every code resolver answers the honest empty value", () => {
    for (const spelling of RAW_PORTED_SINGLE_SEGMENT) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe("");
      expect(orgOf(spelling)).toBe("");
    }
  });

  for (const copy of recipeCopies) {
    test(`${copy.label}: the recipe empties the spelling, never the port digits`, () => {
      for (const spelling of RAW_PORTED_SINGLE_SEGMENT) {
        expect(runRecipe(copy.lines[0] ?? "", spelling)).toBe("");
      }
    });

    test(`${copy.label}: the ported raw FILE spellings keep their pinned answers (corpus guard)`, () => {
      // The two-segment ported raw spellings repo-string-rawhost-port.test.ts
      // pins healthy — the fix must not regress them.
      expect(
        runRecipe(
          copy.lines[0] ?? "",
          "https://raw.githubusercontent.com:443/acme/widgets/main/x.ts"
        )
      ).toBe("acme/widgets");
      expect(
        runRecipe(
          copy.lines[0] ?? "",
          "raw.githubusercontent.com:22/acme/widgets"
        )
      ).toBe("acme/widgets");
      expect(
        runRecipe(copy.lines[0] ?? "", "raw.githubusercontent.com:443")
      ).toBe("");
    });
  }
});
