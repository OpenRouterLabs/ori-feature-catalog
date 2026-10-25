import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import type { InstallationToken } from "@ori-monorepo/working-with-github/gh-app-token.ts";

import { GhAppError } from "@ori-monorepo/working-with-github/gh-app-token.ts";

import {
  formatOutcome,
  parseCleanupArgs,
  runCleanup,
} from "./cleanup-worktrees.ts";

interface Writers {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** Collect writes to the two output channels so assertions can inspect them. */
const makeWriters = (): {
  readonly out: string[];
  readonly err: string[];
  readonly writers: Writers;
} => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    err,
    out,
    writers: {
      err: (t: string): void => {
        err.push(t);
      },
      out: (t: string): void => {
        out.push(t);
      },
    },
  };
};

describe("parseCleanupArgs", () => {
  test("defaults: no flags, GITHUB_REPO from env, cwd as repoDir, default worktrees root, not dry-run", () => {
    expect(
      parseCleanupArgs([], { GITHUB_REPO: "owner/repo" }, "/repo/checkout")
    ).toEqual({
      dryRun: false,
      repo: "owner/repo",
      repoDir: "/repo/checkout",
      worktreesRoot: "/tmp/worktrees",
    });
  });

  test("--repo overrides GITHUB_REPO", () => {
    expect(
      parseCleanupArgs(
        ["--repo", "other/repo"],
        { GITHUB_REPO: "owner/repo" },
        "/repo/checkout"
      )
    ).toEqual({
      dryRun: false,
      repoFlagValue: "other/repo",
      repo: "other/repo",
      repoDir: "/repo/checkout",
      worktreesRoot: "/tmp/worktrees",
    });
  });

  test("--repo tolerates the same spellings GITHUB_REPO does (a full https URL with optional .git)", () => {
    // Regression: a raw URL passed through 404s every PR lookup, so the sweep
    // reports each worktree as an error instead of matching its PRs.
    expect(
      parseCleanupArgs(
        ["--repo", "https://github.com/other/repo.git"],
        { GITHUB_REPO: "owner/repo" },
        "/repo/checkout"
      )
    ).toEqual({
      dryRun: false,
      repoFlagValue: "https://github.com/other/repo.git",
      repo: "other/repo",
      repoDir: "/repo/checkout",
      worktreesRoot: "/tmp/worktrees",
    });
  });

  test("--repo-dir, --worktrees-root, and --dry-run", () => {
    expect(
      parseCleanupArgs(
        [
          "--repo-dir",
          "/other/checkout",
          "--worktrees-root",
          "/tmp/custom",
          "--dry-run",
        ],
        { GITHUB_REPO: "owner/repo" },
        "/repo/checkout"
      )
    ).toEqual({
      dryRun: true,
      repo: "owner/repo",
      repoDir: "/other/checkout",
      worktreesRoot: "/tmp/custom",
    });
  });

  test("--repo-dir and --worktrees-root values are trimmed, not passed through padded", () => {
    // Pre-fix: `readFlag` marked a padded path "usable" (not empty after
    // trim) but returned the RAW value, so `--worktrees-root " /tmp/w "` sent
    // the sweep at a nonexistent directory: `realpath` fell back to the
    // padded string (ENOENT → input unchanged), `readdir` swallowed the
    // ENOENT, and the sweep exited 0 reporting "nothing under the worktrees
    // root" — the same silent-no-op class as #75/#104, reachable through a
    // padded flag value. `mint-token.ts` and `register-gh-app.ts` trim the
    // same shape; the path flags must match them.
    expect(
      parseCleanupArgs(
        ["--repo", "o/r", "--worktrees-root", " /tmp/w "],
        {},
        "/repo/checkout"
      )
    ).toMatchObject({
      repo: "o/r",
      repoDir: "/repo/checkout",
      worktreesRoot: "/tmp/w",
    });
    expect(
      parseCleanupArgs(
        ["--repo", "o/r", "--repo-dir", " /repo/checkout "],
        {},
        "/fallback/cwd"
      )
    ).toMatchObject({
      repoDir: "/repo/checkout",
      worktreesRoot: "/tmp/worktrees",
    });
  });

  test("a value-taking flag present with no usable value is a usage error, never a silent default", () => {
    // `--repo --dry-run` must NOT silently fall back to GITHUB_REPO and sweep
    // the wrong repo's slug directory — the sibling CLIs (mint-token.ts,
    // commit-via-api.ts, register-gh-app.ts) all fail loudly on this shape.
    expect(
      parseCleanupArgs(
        ["--repo", "--dry-run"],
        { GITHUB_REPO: "owner/repo" },
        "/repo/checkout"
      ).missingFlagValue
    ).toBe("--repo");
    // A trailing flag with no value slot at all is the same usage error.
    expect(
      parseCleanupArgs(
        ["--repo"],
        { GITHUB_REPO: "owner/repo" },
        "/repo/checkout"
      ).missingFlagValue
    ).toBe("--repo");
    // `--repo-dir` and `--worktrees-root` are covered too: silently running
    // git from cwd (or sweeping /tmp/worktrees) instead of the given value
    // is the same mis-route.
    expect(
      parseCleanupArgs(
        ["--repo", "o/r", "--repo-dir", "--dry-run"],
        {},
        "/repo/checkout"
      ).missingFlagValue
    ).toBe("--repo-dir");
    expect(
      parseCleanupArgs(
        ["--repo", "o/r", "--worktrees-root"],
        {},
        "/repo/checkout"
      ).missingFlagValue
    ).toBe("--worktrees-root");
    // Well-formed argv carries no marker.
    expect(
      parseCleanupArgs(
        ["--repo", "o/r", "--dry-run"],
        {},
        "/repo/checkout"
      ).missingFlagValue
    ).toBeUndefined();
  });

  test("an explicitly-passed empty flag value is the same usage error, not a silent fallback", () => {
    // Pre-fix: `--repo ""` read undefined from readFlag and silently fell
    // back to GITHUB_REPO, while the CLI's failure message ("no --repo given
    // and GITHUB_REPO is unset") misdiagnosed a SET GITHUB_REPO as unset —
    // mint-token.ts treats this exact shape as a usage error (#98/#107),
    // and the sweep must not run against a silently-derived default repo.
    expect(
      parseCleanupArgs(
        ["--repo", "", "--dry-run"],
        { GITHUB_REPO: "owner/repo" },
        "/repo/checkout"
      ).missingFlagValue
    ).toBe("--repo");
    // An empty --repo-dir / --worktrees-root is the same class: an empty
    // cwd string for git, or an empty sweep root, is never the intent.
    expect(
      parseCleanupArgs(
        ["--repo", "o/r", "--repo-dir", ""],
        {},
        "/repo/checkout"
      ).missingFlagValue
    ).toBe("--repo-dir");
    expect(
      parseCleanupArgs(
        ["--repo", "o/r", "--worktrees-root", " "],
        {},
        "/repo/checkout"
      ).missingFlagValue
    ).toBe("--worktrees-root");
    // A whitespace-only --repo value is the same as an empty one.
    expect(
      parseCleanupArgs(
        ["--repo", "  ", "--dry-run"],
        { GITHUB_REPO: "owner/repo" },
        "/repo/checkout"
      ).missingFlagValue
    ).toBe("--repo");
  });
});

describe("formatOutcome", () => {
  test("renders decision, path, and detail", () => {
    expect(
      formatOutcome({
        branch: "b",
        decision: "removed",
        detail: "removed (PR #1 closed, tree clean)",
        path: "/tmp/worktrees/x/b",
      })
    ).toBe("[removed] /tmp/worktrees/x/b — removed (PR #1 closed, tree clean)");
  });
});

describe("runCleanup (ambient mode)", () => {
  test("sweeps without a token when ambient=true — no mint forced, PR lookup goes bare", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "wwg-ambient-"));
    execFileSync("git", ["init", "-q", "."], { cwd: root });
    const { err, out, writers } = makeWriters();
    let mintForced = false;
    try {
      const mint: Effect.Effect<InstallationToken, GhAppError> = Effect.gen(
        function* () {
          mintForced = true;
          return { expiresAt: "e", token: "never" };
        }
      );
      const code = await Effect.runPromise(
        runCleanup(
          mint,
          {
            dryRun: true,
            repo: "owner/repo",
            repoDir: root,
            worktreesRoot: join(root, "worktrees"),
          },
          writers,
          true
        )
      );
      expect(mintForced).toBe(false);
      expect(code).toBe(0);
      expect(err).toEqual([]);
      expect(out).toEqual([
        "cleanup-worktrees: nothing under the worktrees root.\n",
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("an App-mode mint failure is still a hard error (backwards compatibility)", async () => {
    const { err, out, writers } = makeWriters();
    const failure = new GhAppError({
      message: "Bad credentials",
      op: "http",
      status: 401,
    });
    const code = await Effect.runPromise(
      runCleanup(
        Effect.fail(failure),
        {
          dryRun: true,
          repo: "owner/repo",
          repoDir: "/repo/checkout",
          worktreesRoot: "/tmp/worktrees",
        },
        writers,
        false
      )
    );
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err[0]).toContain("could not mint a token");
  });
});

describe("ghJson Authorization header (ambient contract)", () => {
  test("an absent token sends NO Authorization header — never an empty Bearer", async () => {
    const { Effect } = await import("effect");
    const { ghJson } = await import("./commit-api-core.ts");
    const { Schema } = await import("effect");
    const seenHeaders: Record<string, unknown>[] = [];
    const result = await Effect.runPromise(
      ghJson({
        fetchImpl: (url: string, init?: RequestInit): Promise<Response> => {
          seenHeaders.push((init?.headers ?? {}) as Record<string, unknown>);
          return Promise.resolve(Response.json([{ number: 1, state: "closed" }]));
        },
        method: "GET",
        schema: Schema.Array(Schema.Struct({ number: Schema.Number, state: Schema.String })),
        url: "https://api.github.com/repos/owner/repo/pulls",
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (value) => ({ ok: true as const, value }),
        })
      )
    );
    expect(result.ok).toBe(true);
    expect(seenHeaders).toHaveLength(1);
    expect("Authorization" in (seenHeaders[0] ?? {})).toBe(false);
    expect(seenHeaders[0]?.["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });
});

describe("runCleanup", () => {
  test("fails with a clear stderr message when repo can't be resolved", async () => {
    const { err, out, writers } = makeWriters();
    const code = await Effect.runPromise(
      runCleanup(
        Effect.succeed({
          expiresAt: "",
          token: "tok",
        }),
        {
          dryRun: false,
          repo: "",
          repoDir: "/repo/checkout",
          worktreesRoot: "/tmp/worktrees",
        },
        writers
      )
    );
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err[0]).toContain("no --repo given");
  });

  test("a SET GITHUB_REPO that resolves to nothing is not misreported as unset", async () => {
    // The orgs-page INDEX spelling (#203): the env var IS set, so the
    // "not set" wording would be a lie — the diagnostic must name the
    // spelling and say it resolves to no owner/repo. The repo-unset
    // predicate comes from the same env the parse read.
    const { err, out, writers } = makeWriters();
    const code = await Effect.runPromise(
      runCleanup(
        Effect.succeed({
          expiresAt: "",
          token: "tok",
        }),
        {
          dryRun: false,
          repo: "",
          repoDir: "/repo/checkout",
          worktreesRoot: "/tmp/worktrees",
        },
        writers,
        false,
        { GITHUB_REPO: "https://github.com/orgs" }
      )
    );
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err[0]).not.toContain("is not set");
    expect(err[0]).toContain("resolves to no owner/repo");
    expect(err[0]).toContain("https://github.com/orgs");
  });

  test("an explicit --repo that resolves to nothing is reported against the FLAG, never the env", async () => {
    // The #207 "name the actual cause" contract, through the flag path: with
    // `--repo <unresolvable spelling>` the env var may be healthy, so the
    // diagnostic must name the flag value — pre-fix it printed
    // `GITHUB_REPO "acme/widgets" resolves to no owner/repo`, blaming a
    // populated, resolvable env var for a flag the operator passed, and with
    // the env unset it claimed "no --repo given" while --repo WAS given.
    const { err, out, writers } = makeWriters();
    const code = await Effect.runPromise(
      runCleanup(
        undefined,
        {
          dryRun: false,
          repo: "",
          repoFlagValue: "https://github.com/orgs",
          repoDir: "/repo/checkout",
          worktreesRoot: "/tmp/worktrees",
        },
        writers,
        true,
        { GITHUB_REPO: "acme/widgets" }
      )
    );
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err[0]).toContain("--repo");
    expect(err[0]).toContain("https://github.com/orgs");
    expect(err[0]).not.toContain("GITHUB_REPO");
    expect(err[0]).not.toContain("acme/widgets");
  });

  test("writes a diagnostic to stderr and exits 1 on a mint failure", async () => {
    const { err, out, writers } = makeWriters();
    const failure = new GhAppError({
      message: "Bad credentials",
      op: "http",
      status: 401,
    });
    const code = await Effect.runPromise(
      runCleanup(
        Effect.fail(failure),
        {
          dryRun: false,
          repo: "owner/repo",
          repoDir: "/repo/checkout",
          worktreesRoot: "/tmp/worktrees",
        },
        writers
      )
    );
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err[0]).toContain("could not mint a token");
    expect(err[0]).toContain("Bad credentials");
  });

  test("reports nothing to do when the worktrees root holds no worktrees", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "wwg-worktrees-"));
    // A real (empty) git checkout — `git worktree list` needs a repository;
    // a non-repo repoDir is an error outcome now, not "nothing to do".
    execFileSync("git", ["init", "-q", "."], { cwd: root });
    const { err, out, writers } = makeWriters();
    try {
      const code = await Effect.runPromise(
        runCleanup(
          Effect.succeed({ expiresAt: "", token: "tok" }),
          {
            dryRun: true,
            repo: "owner/repo",
            repoDir: root,
            worktreesRoot: join(root, "worktrees"),
          },
          writers
        )
      );
      expect(code).toBe(0);
      expect(err).toEqual([]);
      expect(out).toEqual(["cleanup-worktrees: nothing under the worktrees root.\n"]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
