#!/usr/bin/env bun

import { Result } from "effect";

import { runCarry } from "./carry.ts";

const USAGE = [
  "carry-thread: missing required arguments.",
  "",
  "Usage:",
  "  bun features/slack/skills/carry-thread/scripts/index.ts \\",
  '    --opener "<the message that opens the new thread>"',
  "",
  "The thread being carried is the one this turn is running in",
  "(SLACK_CHANNEL_ID / SLACK_THREAD_TS).",
  "",
].join("\n");

const parseOpener = (argv: readonly string[]): string | undefined => {
  const at = argv.indexOf("--opener");
  if (at === -1) {
    return undefined;
  }
  const rest = argv.slice(at + 1).join(" ").trim();
  return rest.length > 0 ? rest : undefined;
};

const runCarryCli = async (
  argv: readonly string[],
  env: Record<string, string | undefined>
): Promise<void> => {
  const opener = parseOpener(argv);
  if (opener === undefined) {
    process.stderr.write(USAGE);
    process.exit(1);
    return;
  }

  const result = await runCarry({
    env,
    opener,
  });
  if (Result.isFailure(result)) {
    process.stderr.write(`carry-thread: ${result.failure.message}\n`);
    process.exit(1);
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

if (import.meta.main) {
  await runCarryCli(process.argv.slice(2), Bun.env);
}

export { parseOpener, runCarryCli };
