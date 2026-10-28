import { Effect } from "effect";
import { describe, expect, test } from "bun:test";
import { parseMintArgs, resolveMintDeps } from "./scripts/mint-token.ts";
import { parseCleanupArgs, runCleanup } from "./scripts/cleanup-worktrees.ts";

describe("a positional token is a usage error, never a silent default", () => {
  test("mint: a bare repo spelling is refused, not swallowed into a default-App mint", () => {
    const a = parseMintArgs(["acme/widgets"]);
    expect(a.positionalArgv).toBe("acme/widgets");
    expect(a.targetRepo).toBeUndefined();
  });
  test("mint: a stray positional after a complete pair is refused", () => {
    const a = parseMintArgs(["--repo", "o/r", "extra"]);
    expect(a.positionalArgv).toBe("extra");
  });
  test("mint: the bare invocation stays legitimate", () => {
    expect(parseMintArgs([])).toEqual({});
  });
  test("mint: every documented flag invocation stays clean", () => {
    expect(parseMintArgs(["--repo", "o/r"])).toEqual({ targetRepo: "o/r" });
    expect(parseMintArgs(["--org", "acme", "--purpose", "reviewer"])).toEqual({
      targetRepo: "acme",
      purpose: "reviewer",
    });
  });
  test("cleanup: a bare repo spelling is refused, never swept as the default repo", () => {
    const c = parseCleanupArgs(["acme/widgets"], { GITHUB_REPO: "own/repo" }, "/cwd");
    expect(c.positionalArgv).toBe("acme/widgets");
    expect(c.repo).toBe("own/repo");
  });
  test("cleanup: the bare invocation stays legitimate", () => {
    const c = parseCleanupArgs([], { GITHUB_REPO: "own/repo" }, "/cwd");
    expect(c.positionalArgv).toBeUndefined();
    expect(c.repo).toBe("own/repo");
  });
  test("cleanup: --dry-run alone stays clean", () => {
    const c = parseCleanupArgs(["--dry-run"], { GITHUB_REPO: "own/repo" }, "/cwd");
    expect(c.positionalArgv).toBeUndefined();
    expect(c.dryRun).toBe(true);
  });
});

describe("entrypoints fail loudly on a positional token", () => {
  test("mint parse produces the marker and deps null", () => {
    const a = parseMintArgs(["acme/widgets"]);
    expect(resolveMintDeps(a, { GITHUB_REPO: "own/repo" })).toBeNull();
  });
  test("cleanup run refuses the sweep", async () => {
    const args = parseCleanupArgs(["acme/widgets"], { GITHUB_REPO: "own/repo" }, "/cwd");
    const out: string[] = []; const err: string[] = [];
    const code = await Effect.runPromise(runCleanup(undefined, args, { out: (t) => out.push(t), err: (t) => err.push(t) }, false, { GITHUB_REPO: "own/repo" }));
    expect(code).toBe(1);
    expect(err.join("")).toContain("positional");
    expect(out).toEqual([]);
  });
});
