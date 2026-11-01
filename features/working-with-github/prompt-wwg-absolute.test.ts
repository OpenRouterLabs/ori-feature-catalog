import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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

/**
 * Regression (the relative-WWG class): the prompt's `WWG=$(find …)` recipe
 * printed the feature directory RELATIVE to the workspace root
 * (`vendor/ori-feature-catalog/features/working-with-github`), and the change
 * flow `cd`s into the worktree (steps 2 and 4) before step 5 runs
 * `bun "$WWG"/scripts/commit-via-api.ts`. From the worktree that relative
 * path names nothing — bun answers `Module not found` for a vendored or
 * remote-features layout (reproduced in a vendored workspace), and for a
 * local `features/` layout it silently runs the worktree's own half-edited
 * copy of the script. The recipe now makes WWG absolute.
 *
 * The same recipe never searched its last starting point at all: `find`
 * tests starting points against its expressions too, so
 * `-name node_modules -prune` pruned the top-level `node_modules` before
 * descending, and a workspace whose only copy is the installed package got an
 * EMPTY WWG — every `bun "$WWG"/scripts/…` became `bun /scripts/…`.
 */
const prompt = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "prompt.md"),
  "utf-8"
);

const fences: readonly string[] = [
  ...prompt.matchAll(/```bash[^\n]*\n([\s\S]*?)```/g),
].map((match) => match[1] ?? "");

const resolverFence = fences.find((fence) => fence.includes("WWG=$(find")) ?? "";

/** Run the whole resolver fence from `root`, then `cd` into `elsewhere` (the
 *  worktree) and report WWG plus whether a script under it is reachable. */
const resolveThenCd = (
  root: string,
  elsewhere: string
): { readonly wwg: string; readonly reachable: boolean } => {
  const out = execFileSync(
    "bash",
    [
      "-c",
      `cd '${root}' && { ${resolverFence}
}; cd '${elsewhere}' && printf '%s\\n' "$WWG" && { [ -f "$WWG"/scripts/mint-token.ts ] && echo yes || echo no; }`,
    ],
    { encoding: "utf-8" }
  );
  const [wwg = "", reachable = ""] = out.trimEnd().split("\n");
  return { reachable: reachable === "yes", wwg };
};

const withLayout = (
  build: (root: string) => void,
  check: (root: string, worktree: string) => void
): void => {
  const root = mkdtempSync(join(tmpdir(), "wwg-abs-"));
  const worktree = mkdtempSync(join(tmpdir(), "wwg-abs-wt-"));
  try {
    build(root);
    check(root, worktree);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(worktree, { force: true, recursive: true });
  }
};

const featureAt = (root: string, path: string): void => {
  mkdirSync(join(root, path, "scripts"), { recursive: true });
  writeFileSync(join(root, path, "scripts/mint-token.ts"), "");
};

describe("the WWG recipe resolves a path the change flow can use from a worktree", () => {
  test("a vendored layout resolves to an absolute path that still works after cd \"$WT\"", () => {
    withLayout(
      (root) => {
        featureAt(root, "vendor/ori-feature-catalog/features/working-with-github");
      },
      (root, worktree) => {
        const { reachable, wwg } = resolveThenCd(root, worktree);
        expect(wwg).toBe(
          join(root, "vendor/ori-feature-catalog/features/working-with-github")
        );
        expect(reachable).toBe(true);
      }
    );
  });

  test("a local features/ layout resolves to the workspace copy, never the worktree's", () => {
    withLayout(
      (root) => {
        featureAt(root, "features/working-with-github");
      },
      (root, worktree) => {
        featureAt(worktree, "features/working-with-github");
        const { wwg } = resolveThenCd(root, worktree);
        expect(wwg).toBe(join(root, "features/working-with-github"));
      }
    );
  });

  test("an installed-package-only layout is found under node_modules", () => {
    withLayout(
      (root) => {
        featureAt(
          root,
          "node_modules/.bun/wwg@1/node_modules/@ori-monorepo/working-with-github"
        );
        mkdirSync(join(root, "node_modules/@ori-monorepo"), { recursive: true });
        symlinkSync(
          "../.bun/wwg@1/node_modules/@ori-monorepo/working-with-github",
          join(root, "node_modules/@ori-monorepo/working-with-github")
        );
      },
      (root, worktree) => {
        const { reachable, wwg } = resolveThenCd(root, worktree);
        expect(wwg).toBe(
          join(root, "node_modules/@ori-monorepo/working-with-github")
        );
        expect(reachable).toBe(true);
      }
    );
  });

  test("no copy anywhere leaves WWG empty, never the bare workspace root", () => {
    withLayout(
      () => {},
      (root, worktree) => {
        expect(resolveThenCd(root, worktree).wwg).toBe("");
      }
    );
  });

  test("the edit step names files by their path inside the worktree, not via $WWG", () => {
    const editStep = prompt
      .split("\n")
      .find((line) => line.startsWith("3. **Edit files**"));
    expect(editStep).toBeDefined();
    expect(editStep).toContain('"$WT/features/working-with-github/');
    expect(editStep).not.toMatch(/\$WT\/"\$WWG/u);
  });
});
