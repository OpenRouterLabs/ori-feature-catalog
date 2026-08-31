#!/usr/bin/env bun

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
