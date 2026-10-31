import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression (the PR-body quoting class): the PR-open and summary-comment
 * recipes taught a single-quoted `--field body='…'`. A body is prose — the
 * feature's own issue titles and comments carry apostrophes ("don't",
 * "the user's repo", "doesn't") — and one apostrophe inside single quotes
 * breaks the whole `gh api` invocation at shell-PARSE time
 * ("unexpected EOF while looking for matching `'`"), splitting the body at
 * the apostrophe and running the remainder as a new command. An agent
 * following the prompt verbatim lost the publication step exactly when the
 * finding it was publishing read most like prose.
 *
 * The fix is the feature's own established `--message-file` pattern, applied
 * to every body-bearing `gh api` call: write the prose to a temp file and
 * pass `--field body="$(cat "$BODY")"`, which survives both quote kinds.
 * These tests pin the recipe's SHAPE (temp file + `$(cat …)` on the body)
 * and prove the pattern actually parses with an apostrophe inside it, so the
 * prompt cannot regress to the fragile single-quoted form.
 */
const prompt = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "prompt.md"),
  "utf-8"
);

const fences: readonly string[] = [
  ...prompt.matchAll(/```bash[^\n]*\n([\s\S]*?)```/g),
].map((match) => match[1] ?? "");

const prOpenFence = fences.find((fence) => fence.includes("repos/\${REPO}/pulls"));
const mergeFence = fences.find((fence) =>
  fence.includes("pulls/PR_NUMBER/merge")
);

describe("the body-bearing gh api recipes quote prose safely", () => {
  test("the PR-open recipe exists", () => {
    expect(prOpenFence).toBeDefined();
  });

  test("the PR-open recipe never carries a single-quoted --field body", () => {
    // `--field body='…'` is the fragile shape: an apostrophe in the prose
    // breaks the command at parse time. Any single-quoted body= (the old
    // shape) must be gone.
    expect(prOpenFence).not.toMatch(/--field\s+body='.*'/u);
  });

  test("the PR-open recipe reads its body from a temp file via \"$(cat …)\"", () => {
    expect(prOpenFence).toContain('body="$(cat "$BODY")"');
  });

  test("the PR-open recipe writes the body before the call and cleans it up", () => {
    expect(prOpenFence).toMatch(/BODY=\$\(mktemp\); printf '%s\\n'/u);
    expect(prOpenFence).toContain('rm -f "$BODY"');
  });

  test("the summary comment never carries a single-quoted --field body", () => {
    expect(mergeFence).not.toMatch(/--field\s+body='.*'/u);
  });

  test("the summary comment reads its body from a temp file via \"$(cat …)\"", () => {
    expect(mergeFence).toContain('body="$(cat "$SUMMARY")"');
  });

  test("the quoted pattern parses with an apostrophe in the prose", () => {
    // The actual failure the old shape produced: a body carrying "user's"
    // made bash fail with `unexpected EOF while looking for matching \`'`.
    // Feed the NEW pattern's body line — with an apostrophe inside the
    // temp file — through a real bash parse and assert it survives as ONE
    // command whose body keeps the apostrophe whole.
    const dir = mkdtempSync(join(tmpdir(), "wwg-body-"));
    const script = [
      'BODY=$(mktemp)',
      `printf '%s\\n' "Closes #1. The user's spelling doesn't break." > "$BODY"`,
      'echo-run() { printf "%s" "${3#body=}"; }',
      'echo-run gh-api --field body="$(cat "$BODY")"',
      'rm -f "$BODY"',
    ].join("\n");
    try {
      const out = execFileSync("bash", ["-c", script], { encoding: "utf-8" });
      // echo-run prints argv[2] — the parsed body value. The apostrophe and
      // the contraction must both survive the shell parse intact.
      expect(out).toBe("Closes #1. The user's spelling doesn't break.");
    } finally {
      for (const line of script.split("\n")) {
        const m = /BODY=\$\(mktemp\)/.exec(line);
        if (m) {
          // nothing persistent: the script rm -f's its own temp file
        }
      }
      void dir;
    }
  });

  test("the old single-quoted shape fails the same parse (the defect, for contrast)", () => {
    // The pre-fix recipe line, verbatim, with a natural apostrophe: bash
    // reports the unmatched quote. This documents WHY the shape is banned.
    const script =
      'echo-run gh-api --field body=\'Closes #1. The user\'s spelling.\'';
    let message = "";
    try {
      execFileSync("bash", ["-c", script], { encoding: "utf-8" });
    } catch (error) {
      message = String(error);
    }
    // Bash reports the unmatched quote ("…looking for matching `'"), with the
    // exact suffix varying by version — match on the stable stem.
    expect(message).toContain("looking for matching");
  });
});
