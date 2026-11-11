import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("the PR-open recipe writes title and body with quoted heredocs and cleans them up", () => {
    expect(prOpenFence).toContain(`BODY=$(mktemp); cat > "$BODY" <<'EOF'`);
    expect(prOpenFence).toContain(`TITLE=$(mktemp); cat > "$TITLE" <<'EOF'`);
    expect(prOpenFence).toContain('title="$(cat "$TITLE")"');
    expect(prOpenFence).toContain('rm -f "$TITLE" "$BODY"');
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

/**
 * Regression (the prose-expansion class): every prose recipe wrote its text
 * with `printf '%s\\n' "…"`. Inside double quotes bash runs each markdown
 * `code span` as a command and expands each $VAR, so a PR body reading
 * "Fixes the \`mint-token.ts\` crash when $GH_APP_ID is blank" was posted
 * as "Fixes the  crash when  is blank", after bash had tried to run
 * mint-token.ts. The title was a single-quoted argument, which an apostrophe
 * breaks. Each recipe now writes its prose with a quoted heredoc; this runs
 * the commit, PR-open and summary recipes on hostile prose and reads what
 * reached gh and commit-via-api.
 */
describe("the prose recipes send markdown and $VARS verbatim", () => {
  const hostile =
    "Fixes the `mint-token.ts` crash when $GH_APP_ID is blank; the user's repo doesn't break.";
  const dedent = (fence: string): string => fence.replace(/^ {3}/gmu, "");
  const between = (fence: string, from: string, to: string): string => {
    const start = fence.indexOf(from);
    const end = fence.indexOf(to, start);
    return start === -1 || end === -1 ? "" : fence.slice(start, end + to.length);
  };
  const run = (snippet: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "wwg-prose-"));
    try {
      const out = join(dir, "out");
      const stub = (name: string, body: string): void => {
        writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
        chmodSync(join(dir, name), 0o755);
      };
      stub("gh", 'for a in "$@"; do printf "%s\\n" "$a" >> "$OUT"; done');
      stub("bun", 'while [ $# -gt 0 ]; do [ "$1" = --message-file ] && cat "$2" >> "$OUT"; shift; done');
      execFileSync("bash", ["-c", snippet], {
        encoding: "utf-8",
        env: { ...process.env, GH_APP_ID: "12345", OUT: out, PATH: `${dir}:${process.env.PATH ?? ""}`, REPO: "acme/widgets", TOKEN: "t", WWG: dir },
      });
      return readFileSync(out, "utf-8");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  };

  test("the commit message reaches --message-file whole", () => {
    const commitFence = fences.find((fence) => fence.includes("--message-file")) ?? "";
    const snippet = between(dedent(commitFence), "MSG=$(mktemp)", 'rm -f "$MSG"')
      .replace("feat(scope): your commit message", () => hostile);
    expect(snippet).not.toBe("");
    expect(run(snippet)).toBe(`${hostile}\n`);
  });

  test("the PR title and body reach gh whole", () => {
    const snippet = between(dedent(prOpenFence ?? ""), "TITLE=$(mktemp)", 'echo "$PR_URL"')
      .replace("your PR title", () => `fix: don't drop \`code\` or $HOME`)
      .replace("Closes #N. Description of the change.", () => hostile);
    expect(snippet).not.toBe("");
    const sent = run(snippet).split("\n");
    expect(sent).toContain("title=fix: don't drop `code` or $HOME");
    expect(sent).toContain(`body=${hostile}`);
  });

  test("the merge summary reaches gh whole", () => {
    const snippet = between(mergeFence ?? "", "SUMMARY=$(mktemp)", 'rm -f "$SUMMARY"')
      .replace("Merged: <one-line summary>", () => hostile);
    expect(snippet).not.toBe("");
    expect(run(snippet).split("\n")).toContain(`body=${hostile}`);
  });
});
