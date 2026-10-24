import { describe, expect, test } from "bun:test";
// mint-token.ts's own usage header carries copy-paste shell like prompt.md's
// fences, and it is App-mode documentation the feature prompt points every
// mint at — but its two examples interpolated the RAW `$GITHUB_REPO`:
//
//     gh pr list --repo "$GITHUB_REPO"     → gh rejects a URL spelling
//     api.github.com/repos/$GITHUB_REPO    → repos/https://… is not a route
//
// — the exact literals prompt-recipes.test.ts BANNED from prompt.md (gh
// `--repo` takes bare owner/repo; the `repos/{owner}/{repo}` routes 404 on a
// URL-shaped repo), left live in the one file whose whole job is the mint.
// The README documents that every resolver in this feature tolerates URL
// spellings of `GITHUB_REPO`, so a copy-paste of either example from this
// header breaks under exactly those spellings. This suite pins the same
// contract the prompt's recipe suite pins: the examples must interpolate a
// normalized `$REPO`, never the raw env var.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "scripts", "mint-token.ts"),
  "utf-8"
);

/** The spellings every sibling resolver tolerates for `GITHUB_REPO`. */
const URL_SPELLINGS: readonly string[] = [
  "https://github.com/acme/widgets",
  "ssh://git@github.com:22/acme/widgets",
  "git@github.com:acme/widgets.git",
];

describe("mint-token.ts usage examples never interpolate the raw $GITHUB_REPO", () => {
  test("no example line routes the raw env var into gh --repo or a repos/ URL", () => {
    const offenders: readonly string[] = source
      .split("\n")
      .map((line) => line.trim())
      // Comments are prose, not commands — the invariant is what runs.
      .filter((line) => line.includes("$GITHUB_REPO"))
      // The one line allowed to read the raw env var is the normalization
      // definition itself, whose output every example interpolates.
      .filter((line) => !line.includes("printf '%s'"))
      .filter((line) => /--repo "|\$\{?GITHUB_REPO\}?["/]|\$\{?GITHUB_REPO\}?\}/.test(line));
    expect(offenders).toEqual([]);
  });

  test("the header's normalization recipe collapses every tolerated URL spelling", () => {
    const line = source
      .split("\n")
      .find((candidate) => candidate.includes("REPO=$(printf '%s' \"$GITHUB_REPO\""))
      // The header comment indents its examples; strip the doc margin.
      ?.replace(/^\s*\*\s?/u, "")
      ?.trim();
    expect(line).toBeDefined();
    if (line === undefined) {
      return;
    }
    for (const raw of URL_SPELLINGS) {
      const output = execFileSync(
        "bash",
        ["-c", `${line}\nprintf '%s' "$REPO"`],
        {
          encoding: "utf-8",
          env: { ...process.env, GITHUB_REPO: raw },
        }
      );
      expect(output).toBe("acme/widgets");
    }
  });

  test("the two examples interpolate $REPO, not the raw env var", () => {
    expect(source).toContain('gh pr list --repo "$REPO"');
    expect(source).toContain('"https://api.github.com/repos/$REPO"');
    expect(source).not.toContain('gh pr list --repo "$GITHUB_REPO"');
    expect(source).not.toContain("repos/$GITHUB_REPO");
  });
});
