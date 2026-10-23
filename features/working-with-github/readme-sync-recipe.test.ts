import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const readme = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "README.md"),
  "utf-8"
);

/**
 * The README's vendored-sync verification recipe, extracted from its inline
 * `diff -rq …` span. A copy-paste of the doc contract — the test executes
 * exactly what the README tells the operator to run, so a recipe that can
 * never pass (or one that stops catching real drift) fails here.
 *
 * Pre-fix the recipe carried `--no-dereference`: the store path
 * `node_modules/@ori-monorepo/working-with-github` is a symlink into the
 * `.bun` store, and GNU diff with `--no-dereference` compares the LINK
 * instead of descending — exit 2, `No such file or directory`, on every
 * correctly-synced install. A verification command whose steady-state output
 * is a failure teaches the operator to ignore it (#138's own words), which
 * is how the #99 stale-store class slips back in unnoticed.
 */
const recipe = [
  ...readme.matchAll(/`diff -rq\b[\s\S]*?`/gu),
]
  .map((match) => (match[0] ?? "").replace(/[`]/gu, ""))
  .map((span) => span.replace(/\s+/gu, " ").trim())
  .find((span) => span.startsWith("diff "))
  ?? "";

/**
 * A layout faithful to the real one the recipe runs against:
 *
 *   <workspace>/vendor/ori-feature-catalog/features/working-with-github/…
 *   <workspace>/node_modules/@ori-monorepo/working-with-github → <store entry>
 *
 * — a vendored tree (carrying its own `node_modules/`, as it does after the
 * catalog root's workspace install) and a store path that is a SYMLINK,
 * exactly as a `file:` dependency materializes it. The recipe's two
 * relative paths resolve from the workspace root, like the real ones.
 */
const withRecipeLayout = async (
  run: (workspace: string) => void
): Promise<void> => {
  const workspace = mkdtempSync(join(tmpdir(), "wwg-recipe-"));
  try {
    const vendored = join(
      workspace,
      "vendor/ori-feature-catalog/features/working-with-github"
    );
    mkdirSync(vendored, { recursive: true });
    // The vendored tree carries its own node_modules/ after the catalog
    // root's install — the directory `-x node_modules` exists to exclude.
    mkdirSync(join(vendored, "node_modules"), { recursive: true });
    writeFileSync(join(vendored, "gh-app-token.ts"), "export {};\n");

    // The `.bun` store entry, and the node_modules path as a SYMLINK to it —
    // the shape a `file:` dependency materializes.
    const storeEntry = join(
      workspace,
      "node_modules/.bun/@ori-monorepo+working-with-github/store-entry"
    );
    mkdirSync(storeEntry, { recursive: true });
    writeFileSync(join(storeEntry, "gh-app-token.ts"), "export {};\n");
    mkdirSync(join(workspace, "node_modules/@ori-monorepo"), {
      recursive: true,
    });
    symlinkSync(
      storeEntry,
      join(workspace, "node_modules/@ori-monorepo/working-with-github"),
      "dir"
    );
    await run(workspace);
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
};

/** Run the recipe's `diff` line from `cwd`, returning exit + combined output. */
const runDiff = (
  recipeLine: string,
  cwd: string
): { readonly exit: number; readonly out: string } => {
  const result = spawnSync("bash", ["-c", recipeLine], {
    cwd,
    encoding: "utf-8",
  });
  return {
    exit: result.status ?? -1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
};

describe("README vendored-sync verification recipe", () => {
  test("the recipe excludes the vendored node_modules/ and dereferences the store symlink", () => {
    // The contract the recipe pins: exclude the dir only the vendored tree
    // carries, and never compare the store symlink as a link — `diff -rq
    // --no-dereference` exits 2 on every correctly-synced install.
    expect(recipe).toContain("-x node_modules");
    expect(recipe).not.toContain("--no-dereference");
  });

  test("passes (exit 0, no output) on a correctly-synced install", async () => {
    await withRecipeLayout(async (workspace) => {
      const { exit, out } = runDiff(recipe, workspace);
      expect(exit).toBe(0);
      expect(out).toBe("");
    });
  });

  test("still catches real drift: a diverged file exits 1 naming it", async () => {
    await withRecipeLayout(async (workspace) => {
      // Diverge the store copy from the vendored tree — the drift the
      // check exists to surface (a stale `.bun` store serving old bytes).
      writeFileSync(
        join(
          workspace,
          "node_modules/.bun/@ori-monorepo+working-with-github/store-entry/gh-app-token.ts"
        ),
        "export { STALE };\n"
      );
      const { exit, out } = runDiff(recipe, workspace);
      expect(exit).toBe(1);
      expect(out).toContain("gh-app-token.ts");
    });
  });
});