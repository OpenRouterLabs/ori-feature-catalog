import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { commitViaApi, githubFetchUrl } from "./commit-flow.ts";
import { parseCliArgs } from "./commit-via-api.ts";

// In ambient mode no App token can be minted, so a commit made for the
// member asking must resolve no token, send no Authorization header, and
// carry `x-github-as: member` on every GitHub call for the host's proxy.

const fakeGitHub =
  (seen: { url: string; headers: Headers }[]) =>
  (url: string, init?: RequestInit): Promise<Response> => {
    seen.push({ url, headers: new Headers(init?.headers) });
    if (url.includes("/compare/")) return Promise.resolve(Response.json({ status: "ahead", files: [] }));
    if (url.includes("/git/ref/heads/")) return Promise.resolve(Response.json({ object: { sha: "h" } }));
    if (url.includes("/git/commits/")) return Promise.resolve(Response.json({ tree: { sha: "bt" } }));
    if (url.endsWith("/git/blobs")) return Promise.resolve(Response.json({ sha: "b" }));
    if (url.endsWith("/git/trees")) return Promise.resolve(Response.json({ sha: "t" }));
    if (url.endsWith("/git/commits")) return Promise.resolve(Response.json({ sha: "c" }));
    return Promise.resolve(Response.json({}));
  };

describe("commitViaApi — acting as the member", () => {
  test("mints nothing, sends no Authorization, and marks every call x-github-as: member", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wwg-as-member-"));
    try {
      execFileSync("git", ["init", "-q", "."], { cwd: dir });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "root"], { cwd: dir });
      execFileSync("bash", ["-c", `echo hi > "${join(dir, "f.txt")}"`]);
      const seen: { url: string; headers: Headers }[] = [];
      const result = await Effect.runPromise(
        commitViaApi(
          { worktree: dir, branch: "fix-x", message: "m", repo: "owner/repo" },
          {
            asMember: true,
            fetchImpl: fakeGitHub(seen),
            readFile: (p) => Bun.file(p).arrayBuffer(),
            warn: () => undefined,
          }
        ).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, message: error.message }),
            onSuccess: (sha) => ({ ok: true as const, sha }),
          })
        )
      );
      expect(result).toEqual({ ok: true, sha: "c" });
      expect(seen.length).toBeGreaterThan(0);
      for (const call of seen) {
        expect(call.headers.get("x-github-as")).toBe("member");
        expect(call.headers.get("authorization")).toBeNull();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the post-commit fetch URL carries no credential when there is no token", () => {
    expect(githubFetchUrl("owner/repo", undefined)).toBe("https://github.com/owner/repo.git");
    expect(githubFetchUrl("owner/repo", "TOK")).toBe("https://x-access-token:TOK@github.com/owner/repo.git");
  });
});

// `--as workspace` in ambient mode: no token and no `x-github-as`, so the
// host's proxy signs every call with the workspace's own App. Before it, the
// CLI's only ambient path was `--as member`, which an SSO-enforcing org
// (OpenRouterTeam) refuses for a member who has not authorized the App.
type Seen = { url: string; headers: Headers }[];
const runFlow = async (
  deps: { asMember?: boolean; asWorkspace?: boolean },
  seen: Seen,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fakeGitHub(seen)
) => {
  const dir = await mkdtemp(join(tmpdir(), "wwg-as-workspace-"));
  try {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "root"], { cwd: dir });
    execFileSync("bash", ["-c", `echo hi > "${join(dir, "f.txt")}"`]);
    return await Effect.runPromise(
      commitViaApi(
        { worktree: dir, branch: "fix-x", message: "m", repo: "owner/repo" },
        {
          ...deps,
          fetchImpl,
          readFile: (p) => Bun.file(p).arrayBuffer(),
          warn: () => undefined,
        }
      ).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, stage: error.stage, message: error.message }),
          onSuccess: (sha) => ({ ok: true as const, sha }),
        })
      )
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("commitViaApi — acting as the workspace", () => {
  test("mints nothing and sends every call bare: no Authorization, no x-github-as", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    expect(await runFlow({ asWorkspace: true }, seen)).toEqual({ ok: true, sha: "c" });
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call.headers.get("x-github-as")).toBeNull();
      expect(call.headers.get("authorization")).toBeNull();
    }
  });

  test("a refused call fails the commit instead of retrying as the member", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const refuse = (url: string, init?: RequestInit): Promise<Response> => {
      seen.push({ url, headers: new Headers(init?.headers) });
      return Promise.resolve(Response.json({ message: "Resource not accessible by integration" }, { status: 403 }));
    };
    const result = await runFlow({ asWorkspace: true }, seen, refuse);
    expect(result.ok).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) expect(call.headers.get("x-github-as")).toBeNull();
  });

  test("asking for both identities is refused before any GitHub call", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const result = await runFlow({ asMember: true, asWorkspace: true }, seen);
    expect(result).toMatchObject({ ok: false, stage: "args" });
    expect(seen).toEqual([]);
  });
});

describe("parseCliArgs — --as", () => {
  const base = ["--worktree", "/w", "--branch", "b", "--message-file", "/m", "--repo", "o/r"];
  const parse = (argv: readonly string[]) =>
    Effect.runPromise(
      parseCliArgs(argv, {}).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, message: error.message }),
          onSuccess: (parsed) => ({ ok: true as const, asMember: parsed.asMember, asWorkspace: parsed.asWorkspace }),
        })
      )
    );

  test("--as picks exactly one identity, and its absence picks neither", async () => {
    expect(await parse([...base, "--as", "member"])).toEqual({ ok: true, asMember: true, asWorkspace: false });
    expect(await parse([...base, "--as", "workspace"])).toEqual({ ok: true, asMember: false, asWorkspace: true });
    expect(await parse(base)).toEqual({ ok: true, asMember: false, asWorkspace: false });
  });

  test("any other --as value is refused at the parse", async () => {
    const result = await parse([...base, "--as", "app"]);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toContain("use workspace (this workspace's own App) or member (the person asking)");
  });
});
