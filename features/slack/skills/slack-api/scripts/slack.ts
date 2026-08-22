#!/usr/bin/env bun

/**
 * slack.ts — CLI dispatcher for the slack-api skill.
 *
 * The single entry point the agent invokes:
 *   bun features/slack/skills/slack-api/scripts/slack.ts <command> [--flags ...]
 *
 * Commands:
 *   reactions.add, reactions.remove, chat.postMessage, chat.postEphemeral,
 *   chat.update, chat.delete, conversations.replies, conversations.history,
 *   conversations.open, users.list, users.mention, assistant.threads.setTitle
 *
 * Channel resolution is env-first: --channel falls back to $SLACK_CHANNEL_ID,
 * and same-channel posts auto-use $SLACK_THREAD_TS. (users.setPhoto from Perry's
 * slack-render is intentionally omitted — it needs a user token this surface lacks.)
 *
 * This file is the composition root: it is the ONLY module in the skill that
 * touches process.argv / process.exit / stdout / stderr. All routing lives in
 * dispatch-command.ts and the per-command modules, which stay platform-clean.
 */

import { Result } from "effect";

import { dispatchCommand, isCommand, usageText } from "./dispatch-command.ts";
import { parseFlags } from "./result.ts";

const JSON_INDENT = 2;

if (import.meta.main) {
  const [rawCommand, ...rest] = process.argv.slice(2);
  if (!rawCommand || !isCommand(rawCommand)) {
    const problem = rawCommand
      ? `Unknown command: ${rawCommand}\n`
      : "Missing command.\n";
    process.stderr.write(`${problem}${usageText()}`);
    process.exit(1);
  }
  const result = await dispatchCommand(rawCommand, parseFlags(rest));
  if (Result.isFailure(result)) {
    process.stderr.write(`${result.failure.message}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `${JSON.stringify(result.success, null, JSON_INDENT)}\n`
  );
  process.exit(0);
}
