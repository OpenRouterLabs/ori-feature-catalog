// Regression (companion to prompt-recipes.test.ts /
// repo-string-interior-slashes.test.ts): an interior doubled slash COMBINED
// WITH a deep tail — `https://github.com//o/r/tree/main`,
// `github.com//o/r/tree/main`, a hostless `o//r/tree/main` (a copied
// blob/tree/PR address pasted with a doubled path slash) — is the paste class
// BOTH halves of the corpus already pin separately: the interior double
// (repo-string-interior-slashes.test.ts) and the deep tail
// (repo-string-deepurl.test.ts). The code resolvers collapse the pair to
// `o/r` (the interior collapse runs before every anchored rule, the
// deep-collapse rule keys on non-empty segments). Pre-fix the prompt's REPO=
// recipe ran its interior-collapse rule s#([^:])//+#\1/#g AFTER the anchored
// deep-collapse rule s#(^[^/]+/[^/]+)(/.*)?$#\1#, and the deep rule's
// `[^/]+` never matches an empty segment, so the whole raw string fell every
// branch — the recipe emitted `o/r/tree/main` while the code resolver
// answered `o/r`, and every recipe that interpolated it (`gh --repo
// o/r/tree/main`, `repos/o/r/tree/main`, the fetch URL) silently targeted a
// repo no route answers. The recipe must agree with the resolvers, one
// spelling contract.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { resolveRepoFromEnv } from "@ori-monorepo/working-with-github/commit-api-core.ts";

const promptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "prompt.md"
);
const prompt = readFileSync(promptPath, "utf-8");

const fences: readonly string[] = [
  ...prompt.matchAll(/```bash[^\n]*\n([\s\S]*?)```/g),
].map((match) => match[1] ?? "");

const isNormalizerLine = (line: string): boolean =>
  /^\s*REPO=\$\(printf '%s' "\$GITHUB_REPO" \| sed -E /.test(line);

const INTERIOR_DEEP_SPELLINGS: readonly string[] = [
  "https://github.com//o/r/tree/main",
  "github.com//o/r/tree/main",
  "git@github.com://o/r/tree/main",
  "ssh://git@github.com:22//o/r/tree/main",
  "o//r/tree/main",
  "https://github.com//o/r/pull/42",
];

describe("the REPO= recipe collapses an interior double in a deep URL like the resolvers", () => {
  test("the code resolvers collapse each spelling to owner/repo", () => {
    for (const raw of INTERIOR_DEEP_SPELLINGS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("o/r");
    }
  });

  test("the recipe agrees with the resolver on every spelling", () => {
    const line = fences
      .join("\n")
      .split("\n")
      .find((candidate) => isNormalizerLine(candidate))
      ?.trim();
    expect(line).toBeDefined();
    if (line === undefined) {
      return;
    }
    for (const raw of INTERIOR_DEEP_SPELLINGS) {
      const output = execFileSync("bash", ["-c", `${line}\nprintf '%s' "$REPO"`], {
        encoding: "utf-8",
        env: { ...process.env, GITHUB_REPO: raw },
      });
      expect(output).toBe("o/r");
    }
  });
});
