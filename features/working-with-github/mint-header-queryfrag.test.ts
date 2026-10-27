import { describe, expect, test } from "bun:test";
// The mint-token.ts usage header's REPO= recipe drifted from prompt.md's:
// prompt.md's carries the QUERY/FRAGMENT strips (`s#[?][^/]*$##`,
// `s#[#][^/]*$##`) and the final bare-host emptier
// (`s#^(([Hh][Tt][Tt][Pp][Ss]?|…|[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm]$##`),
// and every CODE resolver strips/empties the same spellings
// (repo-string-queryfrag.test.ts, repo-string-colonhost.test.ts). The
// header's copy — the App-mode documentation the feature prompt points
// every mint at — still carries neither, so `GITHUB_REPO=acme/widgets?tab=readme`
// (a browser address-bar copy-paste) left the suffix in `$REPO`:
// `gh --repo acme/widgets?tab=readme` and
// `api.github.com/repos/acme/widgets?tab=readme` — the `?` ends the PATH and
// the route answers 404 for a repo named after the suffix — the exact
// silent-dead-value class #232 closed for prompt.md, reopened through the
// header's copy. This suite pins the header to prompt.md's contract.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const source = readFileSync(
  join(here, "scripts", "mint-token.ts"),
  "utf-8"
);
const prompt = readFileSync(join(here, "prompt.md"), "utf-8");

const recipeOf = (src: string): string => {
  const line = src
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.includes("REPO=$(printf '%s' \"$GITHUB_REPO\""));
  const match =
    line === undefined
      ? null
      : /^REPO=\$\(printf '%s' "\$GITHUB_REPO" \| sed -E '([^']+)'\)$/u.exec(
          line.replace(/^\s*\*\s?/u, "").trim()
        );
  return match?.[1] ?? "";
};

const runRecipe = (recipe: string, raw: string): string =>
  execFileSync("bash", ["-c", `REPO=$(printf '%s' "$GITHUB_REPO" | sed -E '${recipe}')\nprintf '%s' "$REPO"`], {
    encoding: "utf-8",
    env: { ...process.env, GITHUB_REPO: raw },
  });

describe("the mint-token.ts header recipe agrees with prompt.md's", () => {
  const promptRecipe = recipeOf(prompt);

  test("both files carry a recipe", () => {
    expect(promptRecipe).not.toBe("");
    expect(recipeOf(source)).not.toBe("");
  });

  test("the header's recipe is prompt.md's recipe verbatim", () => {
    // One spelling contract: the header's copy must not drift from the
    // prompt's — every rule added to one applies to the other.
    expect(recipeOf(source)).toBe(promptRecipe);
  });

  test("a QUERY or FRAGMENT suffix strips like the code resolvers do", () => {
    const headerRecipe = recipeOf(source);
    for (const raw of [
      "acme/widgets?tab=readme",
      "acme/widgets#anchor",
      "https://github.com/acme/widgets?tab=readme",
      "https://github.com/acme/widgets#frag",
      "ssh://git@github.com:22/acme/widgets?x=1",
    ]) {
      expect(runRecipe(headerRecipe, raw)).toBe("acme/widgets");
    }
  });

  test("a BARE-HOST spelling empties like the code resolvers do", () => {
    const headerRecipe = recipeOf(source);
    for (const raw of [
      "https://github.com",
      "github.com",
      "git@github.com",
      "ssh://git@github.com",
      "HTTPS://github.com",
      "FTP://GitHub.com",
    ]) {
      expect(runRecipe(headerRecipe, raw)).toBe("");
    }
  });
});
