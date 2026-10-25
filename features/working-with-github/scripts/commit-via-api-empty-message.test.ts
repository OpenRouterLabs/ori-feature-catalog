import { describe, expect, test } from "bun:test";
// commit-via-api-empty-message.test.ts — the CLI's `--message-file` read
// must fail an EMPTY (or whitespace-only) message file at the parse
// boundary, never after side effects. Pre-fix the trimmed "" flowed
// through the whole flow: the mint, the ref/head reads, every blob POST
// and the tree POST all landed, and only the final commit POST came back
// 422 "Validation Failed" — unreachable orphan blobs/tree objects stayed
// on the remote and the diagnostic never named the empty message. The
// same late-failure class the sibling flags were closed for (`--branch
// ""` fails at the parse naming the flag, #111/#162).
//
// The guard lives in runCli AFTER the message-file read (parseCliArgs
// cannot see file contents), so this suite drives the real CLI as a
// subprocess: the only reliable way to reach runCli from a test. The
// subprocess must exit non-zero, print the flag-naming diagnostic, and —
// the crux — never reach the network (no GH_APP_* in its env, so a mint
// attempt would fail with the "Missing GitHub App env var(s)" diagnostic
// instead of the empty-message one; asserting the message text therefore
// also proves the guard fires BEFORE the mint).
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(
  fileURLToPath(import.meta.url),
  "..",
  "commit-via-api.ts"
);

/** Run the real CLI with a message file holding `contents`. */
const runCli = async (contents: string): Promise<{ code: number; stderr: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "wwg-emptymsg-"));
  try {
    const messageFile = join(dir, "msg.txt");
    await writeFile(messageFile, contents);
    const result = spawnSync(
      process.execPath,
      [script, "--worktree", dir, "--branch", "b", "--message-file", messageFile],
      {
        encoding: "utf-8",
        env: {
          // fail with a DIFFERENT diagnostic, making the assertion below fail.
          // No GH_APP_*: a run that reached the mint would fail with a
          // DIFFERENT diagnostic, making the assertion below fail. GITHUB_REPO
          // stays set so parseCliArgs gets past its required-flag check and
          // the run reaches the message-file read under test.
          ...process.env,
          GH_APP_ID: "",
          GH_APP_PRIVATE_KEY: "",
          GITHUB_REPO: "owner/repo",
        },
      }
    );
    return { code: result.status ?? -1, stderr: result.stderr };
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};

describe("commit-via-api empty --message-file", () => {
  test("an empty message file fails at the parse, naming the flag — before the mint", async () => {
    const { code, stderr } = await runCli("");
    expect(code).not.toBe(0);
    expect(stderr).toContain("--message-file");
    expect(stderr).toContain("empty");
    // The guard must fire BEFORE the mint: the missing-App diagnostic is
    // the tell that the flow ran on instead of failing at the parse.
    expect(stderr).not.toContain("Missing GitHub App env var");
  });

  test("a whitespace-only message file is the same class", async () => {
    const { code, stderr } = await runCli("  \n\t \n");
    expect(code).not.toBe(0);
    expect(stderr).toContain("--message-file");
    expect(stderr).not.toContain("Missing GitHub App env var");
  });
});
