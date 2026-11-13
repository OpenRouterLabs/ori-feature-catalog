import { afterEach, describe, expect, test } from "bun:test";

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";

import { discoverInstallationId } from "./gh-app-github-api.ts";
import { orgOf, redactUserinfo, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

// Every resolver tolerates a userinfo prefix because `git remote -v` pastes
// carry one, and a remote that persisted its credential reads
// `https://x-access-token:<token>@github.com/…`. When such a spelling resolves
// to no owner/repo (a truncated paste: the bare host, the orgs index), every
// "resolves to no owner/repo" diagnostic quoted the raw value — printing the
// token into stderr, the schedule logs, and any chat the agent relays them to.

const SECRET = "ghs_0123456789abcdefSECRETtoken";
const HERE = dirname(fileURLToPath(import.meta.url));
const UNRESOLVABLE = [
  `https://x-access-token:${SECRET}@github.com`,
  `https://x-access-token:${SECRET}@github.com/orgs`,
  `https://${SECRET}@github.com/`,
  `x-access-token:${SECRET}@github.com:orgs`,
];

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

const run = (script: string, argv: string[], env: Record<string, string>) => {
  const home = mkdtempSync(join(tmpdir(), "wwg-cred-echo-"));
  scratch.push(home);
  const child = Bun.spawnSync(["bun", join(HERE, script), ...argv], {
    cwd: home,
    env: {
      GH_APP_REGISTRY_DIR: home,
      HOME: home,
      PATH: process.env.PATH ?? "",
      ...env,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    code: child.exitCode,
    out: `${child.stdout.toString()}${child.stderr.toString()}`,
  };
};

describe("redactUserinfo", () => {
  test("masks a credential userinfo and keeps the conventional ssh user", () => {
    expect(redactUserinfo(`https://x-access-token:${SECRET}@github.com`)).toBe(
      "https://***@github.com"
    );
    expect(redactUserinfo(`${SECRET}@github.com:orgs`)).toBe(
      "***@github.com:orgs"
    );
    expect(redactUserinfo("git@github.com:orgs")).toBe("git@github.com:orgs");
    expect(redactUserinfo("ssh://git@github.com:22")).toBe(
      "ssh://git@github.com:22"
    );
    expect(redactUserinfo("https://github.com/orgs")).toBe(
      "https://github.com/orgs"
    );
  });

  test.each(UNRESOLVABLE)("the corpus spelling %p resolves to no org", (spelling) => {
    expect(orgOf(spelling)).toBe("");
  });
});

describe("no unresolvable-spelling diagnostic echoes a URL credential", () => {
  test.each(UNRESOLVABLE)("%p", (spelling) => {
    const runs = [
      run("scripts/mint-token.ts", ["--repo", spelling], { GH_APP_ID: "1" }),
      run("scripts/mint-token.ts", ["--purpose", "reviewer"], {
        GH_APP_ID: "1",
        GITHUB_REPO: spelling,
      }),
      run("scripts/cleanup-worktrees.ts", ["--dry-run", "--repo", spelling], {}),
      run("scripts/cleanup-worktrees.ts", ["--dry-run"], {
        GITHUB_REPO: spelling,
      }),
      run("scripts/commit-via-api.ts", ["--repo", spelling], {}),
      run("scripts/commit-via-api.ts", [], { GITHUB_REPO: spelling }),
      run(
        "scripts/register-gh-app.ts",
        [
          "register",
          "--org",
          spelling,
          "--app-id-key",
          "TEAM_ID",
          "--private-key-key",
          "TEAM_KEY",
        ],
        { TEAM_ID: "222", TEAM_KEY: "k" }
      ),
    ];
    for (const result of runs) {
      expect(result.code).toBe(1);
      expect(result.out).toContain("resolves to no");
      expect(result.out).toContain("***@");
      expect(result.out).not.toContain(SECRET);
    }
  }, 60_000);

  test("installation discovery's orgless GITHUB_REPO message", async () => {
    const saved = process.env.GITHUB_REPO;
    process.env.GITHUB_REPO = `https://x-access-token:${SECRET}@github.com/orgs`;
    try {
      const error = await Effect.runPromise(
        Effect.flip(
          discoverInstallationId(
            () => Promise.resolve(Response.json([])),
            "jwt",
            "",
            new Set(["acme"])
          )
        )
      );
      expect(error.message).toContain("resolves to no GitHub org");
      expect(error.message).not.toContain(SECRET);
    } finally {
      if (saved === undefined) {
        delete process.env.GITHUB_REPO;
      } else {
        process.env.GITHUB_REPO = saved;
      }
    }
  });
});

// A token rides outside the userinfo too: in a query string (GitHub's old
// `?access_token=` auth, still in copied URLs) or pasted alone into the wrong
// variable. The query spellings resolve to no owner/repo, so the same
// diagnostics quoted them whole; a bare token resolves to itself as the owner,
// so the registry routing notes printed it.
const QUERY_UNRESOLVABLE = [
  `https://github.com/?access_token=${SECRET}`,
  `https://github.com/orgs?access_token=${SECRET}`,
  `github.com#${SECRET}`,
];

describe("no diagnostic echoes a GitHub token outside the userinfo", () => {
  test("redactUserinfo masks a token in a query, a fragment or alone", () => {
    expect(redactUserinfo(`https://github.com/?access_token=${SECRET}`)).toBe(
      "https://github.com/?access_token=***"
    );
    expect(redactUserinfo(SECRET)).toBe("***");
    expect(redactUserinfo(`github_pat_${"A".repeat(30)}`)).toBe("***");
    expect(redactUserinfo("acme/widgets")).toBe("acme/widgets");
  });

  test.each(QUERY_UNRESOLVABLE)("%p", (spelling) => {
    const runs = [
      run("scripts/mint-token.ts", ["--repo", spelling], { GH_APP_ID: "1" }),
      run("scripts/mint-token.ts", ["--purpose", "reviewer"], {
        GH_APP_ID: "1",
        GITHUB_REPO: spelling,
      }),
      run("scripts/cleanup-worktrees.ts", ["--dry-run", "--repo", spelling], {}),
      run("scripts/cleanup-worktrees.ts", ["--dry-run"], {
        GITHUB_REPO: spelling,
      }),
      run("scripts/commit-via-api.ts", ["--repo", spelling], {}),
      run("scripts/commit-via-api.ts", [], { GITHUB_REPO: spelling }),
    ];
    for (const result of runs) {
      expect(result.code).toBe(1);
      expect(result.out).toContain("resolves to no");
      expect(result.out).not.toContain(SECRET);
    }
  }, 60_000);

  test("a token pasted as the repo never reaches the routing notes", () => {
    const runs = [
      run("scripts/mint-token.ts", ["--repo", SECRET], {}),
      run("scripts/mint-token.ts", ["--purpose", "reviewer"], { GITHUB_REPO: SECRET }),
      run("scripts/mint-token.ts", ["--repo", SECRET], { GITHUB_REPO: "acme/widgets" }),
      run("scripts/mint-token.ts", ["--repo", "other/thing"], { GITHUB_REPO: SECRET }),
      run("scripts/mint-token.ts", ["--repo", SECRET], { GH_APP_ID: "1", GH_APP_PRIVATE_KEY: "k" }),
    ];
    for (const result of runs) {
      expect(result.code).toBe(1);
      expect(result.out).toContain("gh-app-token:");
      expect(result.out).not.toContain(SECRET);
    }
  }, 60_000);

  test("installation discovery names a token-shaped org and allowlist masked", async () => {
    const notFound = await Effect.runPromise(
      Effect.flip(
        discoverInstallationId(
          () => Promise.resolve(Response.json([{ account: { login: "acme" }, id: 1 }])),
          "jwt",
          SECRET,
          new Set([SECRET.toLowerCase()])
        )
      )
    );
    expect(notFound.message).not.toContain(SECRET);
    expect(notFound.message).not.toContain(SECRET.toLowerCase());
  });
});

// A token pasted alone as the repo has no host and one segment, so every
// resolver passed it through as the owner. commit-via-api then printed it
// three times in one error (`GET …/repos/ghs_…/git/ref/heads/x: Not Found —
// branch "x" does not exist on ghs_… POST /repos/ghs_…/git/refs`), the sweep
// and the schedules put it in their request URLs, and the registry opened its
// database in `~/.config/<token, lowercased>/`. A login never holds `_`, so a
// token-shaped owner names no repo.
describe("a token pasted as the repo names no repo", () => {
  const FINE_GRAINED = `github_pat_11ABCDEFG0_${"x".repeat(59)}`;

  test.each([SECRET, `${SECRET}/widgets`, ` ${FINE_GRAINED} `])(
    "%p resolves to no owner/repo",
    (spelling) => {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe("");
    }
  );

  test("a token in the userinfo or the repo segment still leaves the repo", () => {
    expect(
      resolveRepoFromEnv({ GITHUB_REPO: `https://x-access-token:${SECRET}@github.com/acme/widgets` })
    ).toBe("acme/widgets");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "acme/widgets" })).toBe("acme/widgets");
  });

  test.each([SECRET, FINE_GRAINED])("the registry directory is never named after %p", (spelling) => {
    expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe("intern");
  });

  test("every REPO= recipe copy answers what the code resolver does", () => {
    const recipes = [
      ...readFileSync(join(HERE, "prompt.md"), "utf-8").matchAll(/REPO=\$\(printf '%s' "\$GITHUB_REPO" \| (sed -E -e '.*')\)/gu),
      ...readFileSync(join(HERE, "scripts", "mint-token.ts"), "utf-8").matchAll(/REPO=\$\(printf '%s' "\$GITHUB_REPO" \| (sed -E -e '.*')\)/gu),
    ].map((match) => (match[1] ?? "").replaceAll("\\'", "'"));
    expect(recipes).toHaveLength(3);
    const spellings = [SECRET, `${SECRET}/widgets`, ` ${FINE_GRAINED} `, `https://github.com/${SECRET}/widgets`, `https://x-access-token:${SECRET}@github.com/acme/widgets`, "acme/widgets", "ghp_short/widgets"];
    for (const recipe of recipes) {
      for (const spelling of spellings) {
        const out = execFileSync("bash", ["-c", recipe], { encoding: "utf-8", input: spelling }).replace(/\n$/u, "");
        expect(out).toBe(resolveRepoFromEnv({ GITHUB_REPO: spelling }));
      }
    }
  });

  test("commit-via-api and the sweep say so without printing it", () => {
    const runs = [
      run("scripts/commit-via-api.ts", ["--worktree", ".", "--branch", "x", "--message-file", "m", "--as", "member"], { GITHUB_REPO: SECRET }),
      run("scripts/commit-via-api.ts", ["--worktree", ".", "--branch", "x", "--message-file", "m", "--repo", SECRET], {}),
      run("scripts/cleanup-worktrees.ts", ["--dry-run"], { GITHUB_REPO: SECRET }),
      run("scripts/cleanup-worktrees.ts", ["--dry-run", "--repo", SECRET], {}),
    ];
    for (const result of runs) {
      expect(result.code).toBe(1);
      expect(result.out).toContain("resolves to no owner/repo");
      expect(result.out).not.toContain(SECRET);
    }
  }, 60_000);
});
