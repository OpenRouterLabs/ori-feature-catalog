import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// Regression: commit-via-api's pair parser quoted the refused argv token raw.
// #371 routed every CLI's "unrecognized argument" errors through
// displayArgvToken, but this CLI walks argv in --flag/value pairs and a bare
// token in a flag slot fails earlier, as `malformed argument near "<token>"`.
// So a token pasted as a positional (the prompt has to say "you do not pass it
// one") or a credentialed remote URL printed whole into stderr:
//   commit-via-api.ts --worktree "$WT" --branch b "$TOKEN" --message-file m
// The slot is now quoted the way the sibling CLIs quote it: URL userinfo
// masked, a long or multi-line token named by its length.

const SCRIPT = join(import.meta.dir, "commit-via-api.ts");
const PAT = `github_pat_${"A1b2C3d4E5".repeat(8)}xyz`;
const URL_SECRET = "ghs_SECRETSECRETSECRET";

const run = (argv: readonly string[]) => {
  const proc = Bun.spawnSync(["bun", SCRIPT, ...argv], {
    env: { ...process.env, GH_APP_ID: "", GITHUB_REPO: "acme/widgets" },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    code: proc.exitCode,
    output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
  };
};

describe("commit-via-api withholds a secret in a flag slot", () => {
  test("a long token pasted as a positional is named by its length", () => {
    const result = run([
      "--worktree",
      "/tmp/wt",
      "--branch",
      "b",
      PAT,
      "--message-file",
      "/tmp/msg",
    ]);
    expect(result.code).toBe(1);
    expect(result.output).not.toContain(PAT);
    expect(result.output).toContain(
      `malformed argument near "<a ${PAT.length}-character argument, withheld>"`
    );
  });

  test("a credentialed URL pasted as a positional has its userinfo masked", () => {
    const result = run([
      "--worktree",
      "/tmp/wt",
      "--branch",
      "b",
      "--message-file",
      "/tmp/msg",
      `https://x-access-token:${URL_SECRET}@github.com/o/r`,
    ]);
    expect(result.code).toBe(1);
    expect(result.output).not.toContain(URL_SECRET);
    expect(result.output).toContain(
      'malformed argument near "https://***@github.com/o/r"'
    );
  });

  test("a short typo is still quoted as typed", () => {
    const result = run(["--worktree", "/tmp/wt", "branch", "b"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('malformed argument near "branch"');
  });
});
