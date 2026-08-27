#!/usr/bin/env bun

/**
 * spawn-thread CLI entry — fire-and-forget thread dispatcher for the ori
 * Slack chat surface.
 *
 * This file is the thin shebanged shell: it snapshots argv/env, prints usage,
 * and maps `Result` failures to exit codes. Parsing and loopback dispatch live
 * in ./spawn-thread.ts and the `new`-subcommand workflow in ./run-new.ts, so
 * tests can drive them without touching the platform.
 *
 * Two subcommands cover the two real workflows:
 *   new      — open a fresh top-level thread + dispatch atomically.
 *   continue — dispatch into an already-open thread.
 * A flag-only legacy form (no subcommand) is preserved and treated as
 * `continue`.
 */

import { Result } from "effect";

import { parseThreads, runFork } from "./run-fork.ts";
import { runNew } from "./run-new.ts";
import {
  checkDepth,
  parseArgs,
  runContinue,
  Subcommand,
} from "./spawn-thread.ts";

const USAGE = [
  "spawn-thread: missing required arguments.",
  "",
  "Usage:",
  "  # Continue an existing thread:",
  "  bun features/slack/skills/spawn-thread/index.ts continue \\",
  '    --channel <CHANNEL_ID> --thread-ts <THREAD_TS> --prompt "<task>"',
  "",
  "  # Open a new top-level thread + dispatch atomically:",
  "  bun features/slack/skills/spawn-thread/index.ts new \\",
  '    --channel <CHANNEL_ID> --opener "<opener text>" --prompt "<task>"',
  "",
  "  # Open several threads at once, each with its own task:",
  "  bun features/slack/skills/spawn-thread/index.ts fork \\",
  "    --channel <CHANNEL_ID> \\",
  "    --threads '[{\"opener\":\"...\",\"prompt\":\"...\"},{\"opener\":\"...\",\"prompt\":\"...\"}]'",
  "",
  "  # Legacy form (no subcommand) — treated as `continue`:",
  "  bun features/slack/skills/spawn-thread/index.ts \\",
  '    --channel <CHANNEL_ID> --thread-ts <THREAD_TS> --prompt "<task>"',
  "",
].join("\n");

const printUsageAndExit = (): void => {
  process.stderr.write(USAGE);
  process.exit(1);
};

const failWith = (message: string): void => {
  process.stderr.write(`spawn-thread: ${message}\n`);
  process.exit(1);
};

const runNewCommand = async (
  parsed: ReturnType<typeof parseArgs>,
  depth: number,
  env: Record<string, string | undefined>
): Promise<void> => {
  if (!(parsed.channel && parsed.opener && parsed.prompt)) {
    printUsageAndExit();
    return;
  }
  const result = await runNew({
    channel: parsed.channel,
    opener: parsed.opener,
    prompt: parsed.prompt,
    depth,
    env,
  });
  if (Result.isFailure(result)) {
    failWith(result.failure.message);
    return;
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      ...result.success,
    })}\n`
  );
  process.exit(0);
};

const runContinueCommand = async (
  parsed: ReturnType<typeof parseArgs>,
  depth: number,
  env: Record<string, string | undefined>
): Promise<void> => {
  if (!(parsed.channel && parsed.threadTs && parsed.prompt)) {
    printUsageAndExit();
    return;
  }
  const result = await runContinue({
    channel: parsed.channel,
    threadTs: parsed.threadTs,
    prompt: parsed.prompt,
    depth,
    env,
  });
  if (Result.isFailure(result)) {
    failWith(result.failure.message);
    return;
  }
  process.exit(0);
};

/**
 * `fork` parses its own argv rather than going through `parseArgs`: `--opener`
 * and `--prompt` each consume the rest of the line there, which is exactly
 * what a multi-thread request cannot express.
 */
const readFlag = (argv: readonly string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
};

const runForkCommand = async (
  argv: readonly string[],
  depth: number,
  env: Record<string, string | undefined>
): Promise<void> => {
  const channel = readFlag(argv, "--channel");
  if (channel === undefined) {
    printUsageAndExit();
    return;
  }
  const threads = parseThreads(readFlag(argv, "--threads"));
  if (Result.isFailure(threads)) {
    failWith(threads.failure.message);
    return;
  }

  const report = await runFork({
    channel,
    depth,
    env,
    threads: threads.success,
  });

  process.stdout.write(
    `${JSON.stringify({
      ok: report.failed.length === 0,
      ...report,
    })}\n`
  );
  // A partial fork-out is not a success: the caller has to know which threads
  // it can actually refer to.
  process.exit(report.failed.length === 0 ? 0 : 1);
};

const runSpawnThreadCli = async (
  argv: string[],
  env: Record<string, string | undefined>
): Promise<void> => {
  // The depth error message already carries its own "spawn-thread:" prefix.
  const depthResult = checkDepth(env.SPAWN_THREAD_DEPTH);
  if (Result.isFailure(depthResult)) {
    process.stderr.write(`${depthResult.failure.message}\n`);
    process.exit(1);
    return;
  }
  const depth = depthResult.success;

  const parsed = parseArgs(argv);
  const subcommand: Subcommand = parsed.subcommand ?? Subcommand.Continue;
  if (subcommand === Subcommand.Fork) {
    await runForkCommand(argv, depth, env);
    return;
  }
  await (subcommand === Subcommand.New
    ? runNewCommand(parsed, depth, env)
    : runContinueCommand(parsed, depth, env));
};

if (import.meta.main) {
  await runSpawnThreadCli(process.argv.slice(2), Bun.env);
}
