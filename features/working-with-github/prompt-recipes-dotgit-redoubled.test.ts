import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { resolveRepoFromEnv } from "@ori-monorepo/working-with-github/commit-api-core.ts";

// Regression (companion to repo-string-dotgit-suffix.test.ts): a DOUBLED
// `.git` suffix — `o/r.git.git`, `https://github.com/o/r.git.git`, the
// rider-bearing `o/r.git.git?x=1`, and the `/.git` forms `o/.git.git` /
// `https://github.com/o/.git.git` (a clone suffix typed or pasted twice —
// the same paste family the rider corpus pins) — is a spelling every CODE
// resolver already collapses: `resolveRepoFromEnv` re-strips the suffix its
// own first strip exposes (its own comment: "A `.git` exposed by THAT
// re-trim strips too" — the `.git`/separator cycle runs both ways), and
// orgOf/resolveAllowedOrgs/resolveConfigDirName agree (pinned by the code
// suites). Pre-fix the prompt's REPO= recipe stripped `.git` exactly ONCE
// (`s#\.git$##` with no re-strip after the separator re-trim), so the
// DOUBLED spelling answered `o/r.git` while every code resolver answered
// the healthy `o/r` — one spelling, four disagreeing answers, the exact
// one-spelling contract the recipe suites exist to hold. Every interpolation
// of the dead value 404s (verified live: `repos/octocat/Hello-World.git` —
// 404), `gh --repo` rejects it, and a worktree SLUG keyed on
// `o-r.git` is a directory no sweep lists.
//
// The fix mirrors the code resolver's cycle in sed: after the `.git` strip
// and its separator re-trim, re-strip the `.git` the re-trim can expose.
// The spellings this adds are unreachable for real repos (GitHub itself
// refuses a repo NAME ending `.git`), but the RECIPE is documentation of the
// resolvers' contract — the code side already pins the doubled form
// (repo-string-slashdotgit.test.ts covers `o/r /.git/.git`), and a recipe
// that answers differently from the code on the same input drifts silently
// apart, the exact #159/#169/#203 class the recipe suites close.

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

/** Every normalizer line prompt.md carries (it appears once per fence set). */
const normalizerLines: readonly string[] = fences
  .flatMap((fence) => fence.split("\n"))
  .filter((line) => isNormalizerLine(line))
  .map((line) => line.trim());

/** A doubled-.git spelling and the healthy pair it must collapse to. */
const REDOUBLED: readonly { readonly raw: string; readonly normalized: string }[] =
  [
    { normalized: "acme/widgets", raw: "acme/widgets.git.git" },
    { normalized: "acme/widgets", raw: "https://github.com/acme/widgets.git.git" },
    { normalized: "acme/widgets", raw: "https://github.com/acme/widgets.git.git/" },
    { normalized: "acme/widgets", raw: "git@github.com:acme/widgets.git.git" },
    { normalized: "acme/widgets", raw: "acme/widgets.git.git?x=1" },
    { normalized: "acme/widgets", raw: "acme/widgets.git.git#frag" },
    // The `/.git` half: the separator-then-suffix form, doubled the same way.
    { normalized: "acme", raw: "acme/.git.git" },
    { normalized: "acme", raw: "https://github.com/acme/.git.git" },
  ];

describe("the REPO= recipe re-strips a doubled .git suffix like every code resolver", () => {
  test("prompt.md carries the normalizer line", () => {
    expect(normalizerLines.length).toBeGreaterThan(0);
  });

  test("every normalizer copy collapses the doubled .git spellings", () => {
    for (const line of normalizerLines) {
      for (const spelling of REDOUBLED) {
        const output = execFileSync(
          "bash",
          ["-c", `${line}\nprintf '%s' "$REPO"`],
          {
            encoding: "utf-8",
            env: { ...process.env, GITHUB_REPO: spelling.raw },
          }
        );
        expect(output).toBe(spelling.normalized);
      }
    }
  });

  test("the code resolver agrees on every spelling (the one-spelling contract)", () => {
    for (const spelling of REDOUBLED) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling.raw })).toBe(
        spelling.normalized
      );
    }
  });

  test("the recipe still collapses the single-.git control spellings", () => {
    // The fix must not over-strip: a repo name LEGITIMATELY containing a
    // `.git` interior (never as a suffix) is untouched by every resolver,
    // and the single-suffix spellings keep their pinned answers.
    const line = normalizerLines[0];
    expect(line).toBeDefined();
    if (line === undefined) {
      return;
    }
    for (const [raw, normalized] of [
      ["acme/widgets", "acme/widgets"],
      ["acme/widgets.git", "acme/widgets"],
      ["https://github.com/acme/widgets.git", "acme/widgets"],
      ["acme/widgets.git/", "acme/widgets"],
    ] as const) {
      const output = execFileSync(
        "bash",
        ["-c", `${line}\nprintf '%s' "$REPO"`],
        {
          encoding: "utf-8",
          env: { ...process.env, GITHUB_REPO: raw },
        }
      );
      expect(output).toBe(normalized);
    }
  });
});
