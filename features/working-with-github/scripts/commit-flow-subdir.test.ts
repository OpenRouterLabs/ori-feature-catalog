import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import type { FetchLike } from "./commit-api-core.ts";

import { commitViaApi } from "./commit-via-api.ts";

// Regression: `git status` lists changes from the checkout root, but the flow
// read each file relative to --worktree. With --worktree at a subdirectory, a
// changed `pkg/a.txt` was read as `pkg/pkg/a.txt` (the run died after the
// branch reads), and a changed root `package.json` was committed holding the
// bytes of `pkg/package.json`, a silent corruption.

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

const repo = (): { root: string; base: string } => {
  const root = mkdtempSync(join(tmpdir(), "wwg-subdir-"));
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, "pkg"));
  writeFileSync(join(root, "package.json"), '{"name":"root"}\n');
  writeFileSync(join(root, "pkg/package.json"), '{"name":"pkg"}\n');
  git(root, "add", ".");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  writeFileSync(join(root, "package.json"), '{"name":"root","v":2}\n');
  return { root, base: git(root, "rev-parse", "HEAD") };
};

const fakeGitHub = (base: string, blobs: string[], calls: string[]): FetchLike =>
  (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (url.includes("/git/ref/")) return ok({ object: { sha: base } });
    if (url.includes(`/git/commits/${base}`)) return ok({ sha: base, tree: { sha: "t".repeat(40) } });
    if (url.endsWith("/git/blobs")) {
      blobs.push(Buffer.from(body.content, "base64").toString());
      return ok({ sha: "b".repeat(40) });
    }
    if (url.endsWith("/git/trees")) return ok({ sha: "c".repeat(40) });
    if (url.endsWith("/git/commits")) return ok({ sha: "d".repeat(40) });
    if (url.includes("/git/refs/")) return ok({ object: { sha: "d".repeat(40) } });
    return new Response("{}", { status: 404 });
  }) as FetchLike;

const run = (worktree: string, base: string) => {
  const blobs: string[] = [];
  const calls: string[] = [];
  return Effect.runPromise(
    Effect.result(
      commitViaApi(
        { worktree, branch: "main", message: "m", repo: "o/r" },
        { token: "t", fetchImpl: fakeGitHub(base, blobs, calls), warn: () => {} }
      )
    )
  ).then((result) => ({ result, blobs, calls }));
};

describe("commit-via-api refuses a --worktree below the checkout root", () => {
  test("a subdirectory is refused before any API call, naming the checkout root", async () => {
    const { root, base } = repo();
    try {
      const { result, blobs, calls } = await run(join(root, "pkg"), base);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.stage).toBe("args");
        expect(result.failure.message).toContain("pkg/");
        expect(result.failure.message).toContain("rev-parse --show-toplevel");
      }
      // Pre-fix: the root package.json was uploaded with pkg/package.json's bytes.
      expect(blobs).toEqual([]);
      expect(calls).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the checkout root still commits the root file's own bytes", async () => {
    const { root, base } = repo();
    try {
      const { result, blobs } = await run(root, base);
      expect(result._tag).toBe("Success");
      expect(blobs).toEqual(['{"name":"root","v":2}\n']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
