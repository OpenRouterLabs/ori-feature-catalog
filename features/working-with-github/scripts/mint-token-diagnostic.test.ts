import { describe, expect, test } from "bun:test";
// The CLI entrypoint's purpose-only failure diagnostic must name the actual
// cause, the same "never blame a healthy env var / never invent a spelling"
// discipline #207/#219/#220 pin for the sibling CLIs. Pre-fix, the final
// `? :` branch of the null-mintDeps diagnostic keyed on
// `orgOf(GITHUB_REPO) === ""` — true for BOTH an unset var (orgOf("") === "")
// and a set-but-orgless one, so a genuinely UNSET GITHUB_REPO printed
// `mint-token: GITHUB_REPO "" resolves to no GitHub org — …` — blaming a
// spelling an env var that does not exist never had, while the message the
// CLI's own docstring promises ("pass --repo/--org or set GITHUB_REPO") sat
// unreachable on the branch below it. This suite drives the real CLI as a
// subprocess for each cause and pins the stderr/exit contract.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "mint-token.ts"
);

interface Run {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

// The CLI must fail fast (before any mint) in every case here, so no App
// credentials are needed; the env keeps them explicitly empty.
const runPurposeOnly = (repo: string | undefined): Run => {
  const result = spawnSync(
    "bun",
    [script, "--purpose", "reviewer"],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        GH_APP_ID: "",
        GH_APP_PRIVATE_KEY: "",
        ...(repo === undefined ? {} : { GITHUB_REPO: repo }),
      },
    }
  );
  return {
    code: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
};

describe("mint-token --purpose diagnostics (the purpose-only failure)", () => {
  test("an UNSET GITHUB_REPO is told to set it, never blamed for a spelling", () => {
    const run = runPurposeOnly(undefined);
    expect(run.code).toBe(1);
    // The old message claimed the env var "resolves to no GitHub org" — a
    // spelling complaint about a variable that is not there at all.
    expect(run.stderr).not.toContain("resolves to no GitHub org");
    expect(run.stderr).toContain(
      "mint-token: --purpose needs a target org: pass --repo/--org or set GITHUB_REPO"
    );
    expect(run.stderr).not.toContain('GITHUB_REPO ""');
    // No token on stdout — the failure path writes only to stderr.
    expect(run.stdout).toBe("");
  });

  test("a SET-but-orgless GITHUB_REPO still names its spelling", () => {
    const run = runPurposeOnly("https://github.com/orgs");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('GITHUB_REPO "https://github.com/orgs"');
    expect(run.stderr).toContain("resolves to no GitHub org");
    expect(run.stderr).toContain("--purpose cannot route to a registered App");
  });

  test("a whitespace-only GITHUB_REPO is unset, not a spelling complaint", () => {
    const run = runPurposeOnly("   ");
    expect(run.code).toBe(1);
    expect(run.stderr).not.toContain("resolves to no GitHub org");
    expect(run.stderr).toContain("--purpose needs a target org");
  });
});
