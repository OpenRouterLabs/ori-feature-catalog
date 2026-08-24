/**
 * end-to-end.test.ts — the real CLI, as a real process, with no credentials.
 *
 * `dispatch-command.test.ts` calls the router directly, so the composition
 * root — argv slicing, which stream each outcome is written to, and the exit
 * code the agent branches on — had never run. The agent parses stdout as JSON,
 * so an error printed there instead of on stderr is a parse failure, and a
 * failure that exits zero is an empty result read as "no messages".
 *
 * Every case here stops before Slack is contacted: either at argument
 * validation, or at the SLACK_BOT_TOKEN check. The env is built from scratch
 * (PATH only) so nothing on the developer's machine can turn one of these into
 * a real API call.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "slack.ts");

interface RunResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

const run = async (
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {}
): Promise<RunResult> => {
  const child = Bun.spawn([process.execPath, SCRIPT, ...args], {
    env: {
      PATH: Bun.env.PATH ?? "",
      ...extraEnv,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    code,
    stderr,
    stdout,
  };
};

describe("the command word", () => {
  test("missing, it prints what the skill can do", async () => {
    const result = await run([]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Missing command.");
    expect(result.stderr).toContain("conversations.history");
  });

  test("unknown, it names the word it did not recognise", async () => {
    const result = await run(["conversations.reply", "--channel", "C1"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown command: conversations.reply");
  });

  test("a write command is unknown, not silently accepted", async () => {
    // This skill is read-only; posting goes through the daemon so that
    // rationing and the one-answer-per-turn rule are not optional.
    const result = await run(["chat.postMessage", "--channel", "C1", "--text", "hi"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown command: chat.postMessage");
  });
});

describe("what it refuses to do without credentials", () => {
  test("a read that would need a token stops at the token check", async () => {
    // The proof that nothing is attempted unauthenticated: with a channel and
    // no token, the only thing that comes back is the name of the variable.
    const result = await run(["users.list"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("SLACK_BOT_TOKEN");
  });

  test("with no channel anywhere, it says how to supply one", async () => {
    const result = await run(["conversations.history"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--channel");
    expect(result.stderr).toContain("SLACK_CHANNEL_ID");
  });

  test("a missing flag is reported before the token is even looked for", async () => {
    // Argument errors are the agent's to fix; a token error is not, so the
    // more actionable one has to win.
    const result = await run(["conversations.replies", "--channel", "C1"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--ts");
    expect(result.stderr).not.toContain("SLACK_BOT_TOKEN");
  });
});

describe("where the channel comes from", () => {
  test("the env supplies it when the flag does not", async () => {
    // Env-first is the whole point of the design: the model never restates
    // coordinates it was not given. Reaching the token error proves the
    // channel resolved.
    const result = await run(["conversations.history"], {
      SLACK_CHANNEL_ID: "C-FROM-ENV",
    });

    expect(result.stderr).toContain("SLACK_BOT_TOKEN");
  });

  test("the literal string \"undefined\" is not a channel", async () => {
    // A shell expanding a variable it does not have hands over this word.
    const result = await run(["conversations.history"], {
      SLACK_CHANNEL_ID: "undefined",
    });

    expect(result.stderr).toContain("No channel");
  });
});
