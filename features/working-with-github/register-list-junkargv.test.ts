import { describe, expect, test } from "bun:test";

import { openGhAppRegistryDb } from "./gh-app-registry.ts";

import { runRegisterCli } from "./scripts/register-gh-app.ts";

/**
 * `register-gh-app list` silently ignores junk argv — the one CLI path in
 * this feature that does. The feature's own uniformity contract (#155, #165)
 * is that a single-dash token (`-verbose`, the near-universal typo for
 * `--verbose`) and an equals-form token (`--org=acme`) are USAGE ERRORS in
 * every CLI, never silently dropped: mint-token.ts, cleanup-worktrees.ts,
 * commit-via-api.ts, and this CLI's own `register` subcommand all run
 * `findJunkArgv` and fail loudly. Pre-fix, `list` never did, so
 * `register-gh-app list -verbose` listed happily — the typo'd flag vanished
 * with no diagnostic, and a `--org=acme` paste the operator believed had been
 * applied silently did nothing.
 */
describe("register-gh-app list rejects junk argv like every CLI (#155/#165 class)", () => {
  const run = (argv: readonly string[]): { code: number; err: string[] } => {
    const db = openGhAppRegistryDb(":memory:");
    const err: string[] = [];
    const out: string[] = [];
    try {
      const code = runRegisterCli({
        argv,
        db,
        env: {},
        writers: {
          err: (text) => {
            err.push(text);
          },
          out: (text) => {
            out.push(text);
          },
        },
      });
      return { code, err };
    } finally {
      db.close();
    }
  };

  test("list with a single-dash token fails loudly instead of listing", () => {
    const { code, err } = run(["list", "-verbose"]);
    expect(code).toBe(1);
    expect(err[0]).toContain("unrecognized argument");
    expect(err[0]).toContain("-verbose");
  });

  test("list with an equals-form token fails loudly instead of listing", () => {
    const { code, err } = run(["list", "--org=acme"]);
    expect(code).toBe(1);
    expect(err[0]).toContain("unrecognized argument");
    expect(err[0]).toContain("--org=acme");
  });

  test("list with clean argv still lists", () => {
    const { code, err } = run(["list"]);
    expect(code).toBe(0);
    expect(err).toEqual([]);
  });

  test("list with an unknown double-dash flag is refused, matching mint-token", () => {
    // An unknown well-formed `--flag` used to be ignored by design here,
    // but mint-token.ts later closed the shape for itself: a typo'd flag
    // (`--porpose reviewer`) silently swallowed its VALUE token with it,
    // and on the register path that landed the row under the wrong purpose
    // with exit 0. One contract, every CLI — the unknown flag is refused
    // with the token named (see unknown-flag-guard.test.ts for the
    // register-path reproduction).
    const { code, err } = run(["list", "--verbose"]);
    expect(code).toBe(1);
    expect(err[0]).toContain("unrecognized argument");
    expect(err[0]).toContain("--verbose");
  });
});
