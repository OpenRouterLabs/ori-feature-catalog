#!/usr/bin/env bun

import { resolveHttpPort } from "#skills/spawn-thread/scripts/spawn-thread.ts";

const USAGE = [
  "slack-attach: missing required arguments.",
  "",
  "Usage:",
  "  bun features/slack/skills/slack-attach/scripts/index.ts \\",
  '    --path <FILE> [--title "<title>"] [--comment "<message>"]',
  "",
].join("\n");

const flag = (argv: readonly string[], name: string): string | undefined => {
  const at = argv.indexOf(name);
  if (at === -1) {
    return undefined;
  }
  const rest = argv.slice(at + 1);
  const end = rest.findIndex((token) => token.startsWith("--"));
  const value = (end === -1 ? rest : rest.slice(0, end)).join(" ").trim();
  return value === "" ? undefined : value;
};

const present = (value: string | undefined): string | undefined =>
  value === undefined || value === "" || value === "undefined"
    ? undefined
    : value;

export const runAttachCli = async (
  argv: readonly string[],
  env: Record<string, string | undefined>
): Promise<void> => {
  const path = flag(argv, "--path");
  const channel = present(env.SLACK_CHANNEL_ID);
  const threadTs = present(env.SLACK_THREAD_TS);

  if (path === undefined) {
    process.stderr.write(USAGE);
    process.exit(1);
    return;
  }
  if (channel === undefined || threadTs === undefined) {
    process.stderr.write(
      "slack-attach: no Slack thread in scope (SLACK_CHANNEL_ID / SLACK_THREAD_TS unset)\n"
    );
    process.exit(1);
    return;
  }

  const response = await fetch(
    `http://127.0.0.1:${resolveHttpPort(env)}/slack/thread/attach`,
    {
      body: JSON.stringify({
        channel,
        comment: flag(argv, "--comment"),
        path,
        thread_ts: threadTs,
        title: flag(argv, "--title"),
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }
  ).catch((cause: unknown) => {
    process.stderr.write(`slack-attach: request failed: ${String(cause)}\n`);
    process.exit(1);
    return undefined as never;
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "no body");
    process.stderr.write(
      `slack-attach: rejected (HTTP ${response.status}): ${detail}\n`
    );
    process.exit(1);
    return;
  }

  process.stdout.write(`${await response.text()}\n`);
  process.exit(0);
};

if (import.meta.main) {
  await runAttachCli(process.argv.slice(2), process.env);
}
