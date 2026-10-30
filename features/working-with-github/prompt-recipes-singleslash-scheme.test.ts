// Regression (companion to repo-string-singleslash-scheme.test.ts, the code
// half): a scheme whose separator lost a slash — `https:/github.com/o/r`,
// `https:github.com/o/r` (curl normalizes both and answers 200, so they are
// real client-accepted spellings of the same URL) — is the same URL as its
// `://` sibling, and pre-fix the prompt's REPO= recipe (both prompt.md copies
// AND mint-token.ts's header copy) answered DEAD for the whole class while the
// four code resolvers answered the healthy pair:
//   - `https:/github.com/acme/widgets` → `https:/acme` (junk every
//     `repos/{repo}` route 404s on and `gh --repo` rejects) — the host-word
//     strip keyed on the scheme's `://`, missed the single-slash form, and
//     welded the surviving `https:/` onto the owner;
//   - `https:/github.com` → itself (raw junk) while the code answered "";
//   - `https:/api.github.com/repos/o/r` → `https:/api.repos`,
//     `https:/raw.githubusercontent.com/o/r/f.ts` → itself, and the index
//     spelling `https:/github.com/orgs` → `https:/` — every one a value no
//     route answers.
// The fix inserts ONE rule after the leading pad strips (so a padded paste
// is already clean, exactly like the code resolvers' trim-first order) and
// before the host-keyed strips: rewrite ONLY the scheme's own separator to
// `://` when what follows is a github.com-shaped host. An scp spec carries no
// scheme word before its colon and a bare `acme:widgets` names no host, so
// neither is touched. One spelling contract, recipe and resolvers.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

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

const SINGLE_SLASH_OWNER_BEARING: readonly string[] = [
  "https:/github.com/acme/widgets",
  "https:github.com/acme/widgets",
  "http:/github.com/acme/widgets",
  "https:/github.com/acme/widgets.git",
  "https:/github.com:443/acme/widgets",
  "HTTPS:/GitHub.com/acme/widgets",
  "SSH:/git@github.com/acme/widgets",
  "git+ssh:/github.com/acme/widgets",
  "ftp:/github.com/acme/widgets",
  " https:/github.com/acme/widgets ",
  "https:/github.com/acme/widgets?tab=readme",
  "https:/api.github.com/repos/acme/widgets",
  "https:/raw.githubusercontent.com/acme/widgets/main/f.ts",
  "https:/www.github.com/acme/widgets",
  "https:/gist.github.com/acme/widgets",
  "https:/codeload.github.com/acme/widgets/tarball/main",
];

const SINGLE_SLASH_NO_OWNER: readonly string[] = [
  "https:/github.com",
  "https:github.com",
  "http:/github.com",
  "https:/raw.githubusercontent.com",
  "ftp:/github.com",
];

const SINGLE_SLASH_INDEX: readonly string[] = [
  "https:/github.com/orgs",
  "https:/github.com/organizations",
];

describe("a single-slash scheme spelling resolves like its :// form in every recipe copy", () => {
  test("every recipe copy carries the scheme-separator rule", () => {
    for (const copy of recipeCopies) {
      for (const line of copy.lines) {
        expect(line).toContain("s#^([a-zA-Z][a-zA-Z0-9+.-]*):/?(");
      }
    }
  });

  test("owner-bearing spellings answer the healthy pair, never the welded junk", () => {
    for (const copy of recipeCopies) {
      for (const line of copy.lines) {
        for (const spelling of SINGLE_SLASH_OWNER_BEARING) {
          expect(runRecipe(line, spelling)).toBe("acme/widgets");
        }
      }
    }
  });

  test("bare-host spellings answer empty, never the raw host string", () => {
    for (const copy of recipeCopies) {
      for (const line of copy.lines) {
        for (const spelling of SINGLE_SLASH_NO_OWNER) {
          expect(runRecipe(line, spelling)).toBe("");
        }
      }
    }
  });

  test("index spellings answer empty, never a partial junk tail", () => {
    for (const copy of recipeCopies) {
      for (const line of copy.lines) {
        for (const spelling of SINGLE_SLASH_INDEX) {
          expect(runRecipe(line, spelling)).toBe("");
        }
      }
    }
  });

  test("the users-page form answers the user login", () => {
    for (const copy of recipeCopies) {
      for (const line of copy.lines) {
        expect(
          runRecipe(line, "https:/api.github.com/users/octocat")
        ).toBe("octocat");
      }
    }
  });

  test("an scp spec and a bare colon pair keep their established answers", () => {
    for (const copy of recipeCopies) {
      for (const line of copy.lines) {
        expect(runRecipe(line, "git@github.com:acme/widgets")).toBe(
          "acme/widgets"
        );
        expect(runRecipe(line, "acme:widgets")).toBe("acme:widgets");
        expect(runRecipe(line, "github.com:22/acme/widgets")).toBe(
          "acme/widgets"
        );
        expect(runRecipe(line, "https://github.com/acme/widgets")).toBe(
          "acme/widgets"
        );
      }
    }
  });
});
