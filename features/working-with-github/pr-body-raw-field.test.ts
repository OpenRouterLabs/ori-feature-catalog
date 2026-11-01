import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression (the typed-field class): the PR-open and summary-comment recipes
 * passed prose through `gh api --field`, gh's TYPED parameter form. `--field`
 * is not a plain string flag — gh rewrites the value before sending it:
 *
 *   - a value starting with `@` is read as a FILENAME: a body opening with a
 *     mention ("@reviewer please look") fails locally with
 *     `error parsing "body" value: open reviewer please look: no such file`,
 *     and the PR is never opened;
 *   - `{owner}`, `{repo}` and `{branch}` ANYWHERE in the value are replaced
 *     from the cwd's git remote — the recipe runs from the worktree, so a body
 *     documenting this feature's own `repos/{owner}/{repo}/…` routes was
 *     silently rewritten to the repo's real owner/name and local branch
 *     (reproduced with gh 2.62.0 against a local mock: the posted body read
 *     `repos/OpenRouterLabs/ori-feature-catalog/contents/{path} on branch
 *     master`), and outside a git checkout the call fails with
 *     `failed to run git: not a git repository`;
 *   - a bare integer or `true`/`false`/`null` is sent as that JSON type, not a
 *     string, which GitHub answers 422.
 *
 * `--raw-field` sends the value as a string, verbatim. The recipes must pass
 * every prose parameter (title, head, base, body) through it.
 */
const prompt = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "prompt.md"),
  "utf-8"
);

const fences: readonly string[] = [
  ...prompt.matchAll(/```bash[^\n]*\n([\s\S]*?)```/g),
].map((match) => match[1] ?? "");

const prOpenFence =
  fences.find((fence) => fence.includes("repos/${REPO}/pulls\"")) ?? "";
const mergeFence =
  fences.find((fence) => fence.includes("pulls/PR_NUMBER/merge")) ?? "";

/** Every `<flag> <name>=` parameter a fence passes, as [flag, name] pairs. */
const fieldParams = (fence: string): readonly (readonly [string, string])[] =>
  [...fence.matchAll(/(--raw-field|--field|-F|-f)\s+([a-z_]+)=/gu)].map(
    (match) => [match[1] ?? "", match[2] ?? ""] as const
  );

const PROSE_PARAMS = new Set(["title", "head", "base", "body"]);

describe("the PR-open and summary-comment recipes send prose verbatim", () => {
  test("the PR-open recipe passes title, head, base and body via --raw-field", () => {
    const params = fieldParams(prOpenFence).filter(([, name]) =>
      PROSE_PARAMS.has(name)
    );
    expect(params.map(([, name]) => name).toSorted()).toEqual([
      "base",
      "body",
      "head",
      "title",
    ]);
    for (const [flag] of params) {
      expect(flag).toBe("--raw-field");
    }
  });

  test("the summary-comment recipe passes its body via --raw-field", () => {
    const bodies = fieldParams(mergeFence).filter(([, name]) => name === "body");
    expect(bodies.length).toBe(1);
    expect(bodies[0]?.[0]).toBe("--raw-field");
  });

  const gh = spawnSync("gh", ["--version"], { encoding: "utf-8" });
  const hasGh = gh.status === 0;

  /**
   * Run `gh api` with one body parameter from a non-git temp dir against an
   * unresolvable host, so nothing reaches GitHub: a value gh rejects while
   * PARSING the field fails before any request with `error parsing "body"`,
   * while a value gh accepts fails later on the network instead.
   */
  const parseError = (flag: string, body: string): string => {
    const cwd = mkdtempSync(join(tmpdir(), "wwg-raw-field-"));
    try {
      const result = spawnSync(
        "gh",
        ["api", "repos/o/r/pulls", "--method", "POST", flag, `body=${body}`],
        {
          cwd,
          encoding: "utf-8",
          env: {
            ...process.env,
            GH_HOST: "wwg-raw-field.invalid",
            GH_TOKEN: "not-a-real-token",
          },
          timeout: 20_000,
        }
      );
      const stderr = result.stderr ?? "";
      return stderr.includes('error parsing "body" value') ? stderr : "";
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  };

  test.skipIf(!hasGh)(
    "behavioral: gh's typed --field rewrites a mention-led or placeholder-bearing body, --raw-field does not",
    () => {
      const mention = "@reviewer please look; closes #1.";
      const placeholders = "Reads repos/{owner}/{repo}/contents on {branch}.";
      // The defect, for contrast: the typed form fails at parse time.
      expect(parseError("--field", mention)).toContain("open reviewer");
      expect(parseError("--field", placeholders)).not.toBe("");
      // The recipe's form sends both verbatim.
      expect(parseError("--raw-field", mention)).toBe("");
      expect(parseError("--raw-field", placeholders)).toBe("");
    },
    60_000
  );
});
