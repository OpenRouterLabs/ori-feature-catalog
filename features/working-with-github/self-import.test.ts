import { describe, expect, test } from "bun:test";

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// A packed intern (the compiled `ori` binary) loads each schedule by
// bundling it with `Bun.build`, and the bundler inside a compiled binary
// cannot resolve a package's import of its OWN name (package self-reference
// through `exports`). Plain `bun` resolves it, so this suite and every
// `bun "$WWG"/scripts/...` run passed, while `ori features validate` on the
// catalog marked this feature invalid and neither schedule loaded:
//
//   could not import schedule "worktree-cleanup" for feature
//   "working-with-github": ModuleLoaderError: Failed to build module for
//   fresh import: .../schedules/worktree-cleanup/schedule.ts
//   Could not resolve: "@ori-monorepo/working-with-github/commit-api-core.ts"
//
// Every module a schedule can reach is therefore imported by relative path.
// Tests run under plain `bun` and may keep the package name.

const ROOT = dirname(fileURLToPath(import.meta.url));
const SELF = /["']@ori-monorepo\/working-with-github\//u;

const modules = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules") {
      return [];
    }
    if (statSync(path).isDirectory()) {
      return modules(path);
    }
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });

describe("working-with-github self-imports", () => {
  test("no module imports the feature's own package name", () => {
    const found = modules(ROOT).filter((path) =>
      SELF.test(readFileSync(path, "utf-8"))
    );
    expect(found.map((path) => relative(ROOT, path))).toEqual([]);
  });

  test("the scan covers both schedules", () => {
    const scanned = modules(ROOT).map((path) => relative(ROOT, path));
    expect(scanned).toContain("schedules/gh-auth-health/schedule.ts");
    expect(scanned).toContain("schedules/worktree-cleanup/schedule.ts");
  });
});
