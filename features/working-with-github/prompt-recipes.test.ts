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
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
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
    // A deep GitHub URL — a copied blob/tree/PR/releases address — is a
    // spelling every sibling resolver in this feature tolerates (#159's own
    // corpus), so the prompt's normalization recipe must collapse it to
    // owner/repo too: the raw output `acme/widgets/tree/main` breaks
    // `gh --repo` (no such repo), the `repos/…` API routes (404), and the
    // github.com fetch URL, exactly the way the two-segment URL spelling
    // did before the recipe normalized it.
    {
      normalized: "acme/widgets",
      raw: "https://github.com/acme/widgets/tree/main",
    },
    {
      normalized: "acme/widgets",
      raw: "https://github.com/acme/widgets/pull/42",
    },
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

describe("prompt.md's WWG resolution recipe prefers the workspace's real source over the .bun store copy", () => {
  // The recipe is copy-paste shell run from the workspace root; this suite
  // executes it against faithful layouts, the same discipline the
  // readme-sync-recipe suite pins the README's `diff -rq` with.
  const recipeOf = (): string => {
    const fence = fences.find((candidate) =>
      candidate.includes("WWG=$(find")
    );
    if (fence === undefined) {
      throw new Error("prompt.md carries no WWG=$(find …) recipe");
    }
    // The recipe statement: from `WWG=$(find` through its closing `)`.
    const start = fence.indexOf("WWG=$(find");
    const rest = fence.slice(start);
    let open = 0;
    let end = -1;
    for (let i = 0; i < rest.length; i += 1) {
      const ch = rest[i];
      if (ch === undefined) {
        break;
      }
      if (ch === "(") {
        open += 1;
      } else if (ch === ")") {
        open -= 1;
        if (open === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) {
      throw new Error("the WWG recipe statement never closes its $()");
    }
    return rest.slice(0, end).replace(/\\\n/gu, " ");
  };

  const runRecipe = (cwd: string): string =>
    // The assignment stands on its own line in real use; find's exit status
    // (a missing starting point makes it non-zero) never gates the capture.
    execFileSync("bash", ["-c", `cd '${cwd}' && { ${recipeOf()}; printf '%s' "$WWG"; }`], {
      encoding: "utf-8",
    });

  test("a vendored workspace resolves to the vendored source tree, not the store symlink", () => {
    // The composed-intern layout this workspace itself runs: the only
    // working-with-github on disk lives under vendor/…/features, while
    // node_modules/@ori-monorepo/working-with-github is a symlink INTO
    // node_modules/.bun/… — a store copy that silently diverges from the
    // vendored tree until a root bun install re-syncs it.
    const root = mkdtempSync(join(tmpdir(), "wwg-recipe-vendored-"));
    try {
      // The real composed-intern workspace carries all four starting points.
      mkdirSync(join(root, "features"), { recursive: true });
      mkdirSync(join(root, ".ori/remote-features"), { recursive: true });
      mkdirSync(join(root, "vendor/ori-feature-catalog/features/working-with-github"), {
        recursive: true,
      });
      mkdirSync(join(root, "node_modules/@ori-monorepo"), { recursive: true });
      mkdirSync(
        join(root, "node_modules/.bun/wwg@file/store/node_modules/@ori-monorepo/working-with-github"),
        { recursive: true }
      );
      symlinkSync(
        "../.bun/wwg@file/store/node_modules/@ori-monorepo/working-with-github",
        join(root, "node_modules/@ori-monorepo/working-with-github")
      );
      expect(runRecipe(root)).toBe(
        "vendor/ori-feature-catalog/features/working-with-github"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a plain features/ layout keeps resolving its own feature directory", () => {
    const root = mkdtempSync(join(tmpdir(), "wwg-recipe-plain-"));
    try {
      mkdirSync(join(root, ".ori/remote-features"), { recursive: true });
      mkdirSync(join(root, "vendor"), { recursive: true });
      mkdirSync(join(root, "node_modules"), { recursive: true });
      mkdirSync(join(root, "features/working-with-github"), { recursive: true });
      expect(runRecipe(root)).toBe("features/working-with-github");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the remote-features cache outranks the installed package", () => {
    const root = mkdtempSync(join(tmpdir(), "wwg-recipe-remote-"));
    try {
      mkdirSync(join(root, "features"), { recursive: true });
      mkdirSync(join(root, "vendor"), { recursive: true });
      mkdirSync(join(root, ".ori/remote-features/cache/working-with-github"), {
        recursive: true,
      });
      mkdirSync(join(root, "node_modules/@ori-monorepo/working-with-github"), {
        recursive: true,
      });
      expect(runRecipe(root)).toBe(
        ".ori/remote-features/cache/working-with-github"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
