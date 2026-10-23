import { describe, expect, test } from "bun:test";
// The prompt's recipes are copy-paste shell: a doc contract this suite pins.
// `gh --repo`, the `repos/…` Git-Data/GitHub-API paths, and the `github.com`
// git-fetch URL all take bare `owner/repo` — but `GITHUB_REPO` is set from
// service env and every sibling resolver tolerates URL spellings
// (`https://github.com/o/r`, a `.git` suffix, a trailing slash) for it. A
// recipe that interpolates the RAW env var produces, for those spellings,
// `gh --repo https://…` (gh rejects the URL form), `repos/https://…` (404),
// and `github.com/https://…` (no such remote) — so every recipe must
// interpolate the normalized `$REPO` the prompt derives once per shell.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const promptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "prompt.md"
);
const prompt = readFileSync(promptPath, "utf-8");

/** Every fenced bash block in the prompt (indented list fences included). */
const fences: readonly string[] = [
  ...prompt.matchAll(/```bash[^\n]*\n([\s\S]*?)```/g),
].map((match) => match[1] ?? "");

/**
 * The one line allowed to mention the raw env var: the normalization
 * definition itself (`REPO=$(printf '%s' "$GITHUB_REPO" | sed -E …)`), whose
 * output every recipe interpolates.
 */
const isNormalizerLine = (line: string): boolean =>
  line.trimStart().startsWith(`REPO=$(printf '%s' "$GITHUB_REPO"`);

/** The spellings every sibling resolver tolerates for `GITHUB_REPO`. */
const SPELLINGS: readonly { readonly raw: string; readonly normalized: string }[] =
  [
    { normalized: "acme/widgets", raw: "acme/widgets" },
    { normalized: "acme/widgets", raw: "https://github.com/acme/widgets" },
    {
      normalized: "acme/widgets",
      raw: "https://github.com/acme/widgets.git",
    },
    {
      normalized: "acme/widgets",
      raw: "git@github.com:acme/widgets.git",
    },
    { normalized: "acme/widgets", raw: "acme/widgets/" },
  ];

describe("prompt.md recipes interpolate the normalized $REPO, never the raw $GITHUB_REPO", () => {
  test("no bash fence interpolates $GITHUB_REPO outside the normalization definition", () => {
    const offenders: string[] = [];
    for (const fence of fences) {
      for (const line of fence.split("\n")) {
        const trimmed = line.trim();
        // Comments are prose, not commands — the invariant is about what runs.
        if (trimmed.startsWith("#")) {
          continue;
        }
        if (/\$\{?GITHUB_REPO\}?/u.test(line) && !isNormalizerLine(line)) {
          offenders.push(trimmed);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the three URL-bearing recipe forms never carry the raw env var", () => {
    // These exact pre-fix literals are the breakage: `gh --repo` rejects the
    // URL form, `/repos/https://…` is not a GitHub API route (404), and
    // `github.com/https://…` cannot resolve as a fetch remote.
    expect(prompt).not.toContain('--repo "$GITHUB_REPO"');
    expect(prompt).not.toContain("repos/${GITHUB_REPO}");
    expect(prompt).not.toContain("github.com/${GITHUB_REPO}");
  });

  test("the normalization recipe itself normalizes every tolerated spelling", () => {
    const line = fences
      .flatMap((fence) => fence.split("\n"))
      .find((candidate) => isNormalizerLine(candidate))
      ?.trim();
    expect(line).toBeDefined();
    if (line === undefined) {
      return;
    }
    for (const spelling of SPELLINGS) {
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
  });
});
