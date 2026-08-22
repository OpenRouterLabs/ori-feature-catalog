/**
 * Shared internal helpers for the slack-api skill.
 *
 * Provides the Slack WebClient, environment thread-context resolution, the
 * cross-channel routing guard, markdown→mrkdwn conversion, and required-flag
 * validation reused across all command modules.
 *
 * Dependency adaptation vs a slack-render reference: this surface has no
 * ori-monorepo egg or global-utils packages, so this module uses
 * `slackify-markdown` for markdown conversion and Effect's `Result` for
 * error-channel primitives.
 *
 * Env-first design (forward-compatible with framework env threading): channel
 * and thread are resolved from the SLACK_CHANNEL_ID / SLACK_THREAD_TS env vars
 * FIRST, falling back to explicit --channel / --thread-ts flags. The literal
 * string "undefined" is treated as absent (defensive guard). All env reads go
 * through an injected env map (defaulting to `Bun.env`), so callers and tests
 * can supply explicit environments. When the framework begins threading literal
 * Slack env vars to the agent runtime, this skill needs zero rewrite — it
 * already prefers env.
 */

import { WebClient } from "@slack/web-api";
import { Result } from "effect";
import { slackifyMarkdown } from "slackify-markdown";

import { isString } from "./result.ts";

/**
 * Build a WebClient from SLACK_BOT_TOKEN in the given env map. Returns a
 * failure if the token is missing so callers decide how to handle it. Mirrors
 * features/slack/lib/post.ts's client().
 */
export const makeClient = (
  env: Record<string, string | undefined> = Bun.env
): Result.Result<WebClient, Error> => {
  const token = env.SLACK_BOT_TOKEN;
  if (!token) {
    return Result.fail(
      new Error("SLACK_BOT_TOKEN is not set — cannot create Slack client")
    );
  }
  return Result.succeed(new WebClient(token));
};

/** Treat the literal string "undefined" (and empty) as absent. */
const presentEnv = (raw: string | undefined): string | undefined =>
  raw && raw !== "undefined" ? raw : undefined;

/**
 * Read the current Slack thread context from the given env map. When the
 * framework threads literal SLACK_CHANNEL_ID / SLACK_THREAD_TS to the agent
 * runtime, these are populated; until then they are typically absent and
 * callers fall back to flags.
 */
export const getThreadContext = (
  env: Record<string, string | undefined> = Bun.env
): {
  channel: string | undefined;
  threadTs: string | undefined;
} => ({
  channel: presentEnv(env.SLACK_CHANNEL_ID),
  threadTs: presentEnv(env.SLACK_THREAD_TS),
});

/** Convert markdown to Slack mrkdwn. Re-exported for command modules. */
export const markdownToSlack = (text: string): string => slackifyMarkdown(text);

const isBlindCrossChannelPost = (input: {
  readonly currentChannel: string | undefined;
  readonly isSameChannel: boolean;
  readonly opts: {
    readonly guardCrossChannel?: boolean | undefined;
    readonly threadTs?: string | undefined;
  };
}): boolean =>
  input.opts.guardCrossChannel !== false &&
  isString(input.currentChannel) &&
  !input.isSameChannel &&
  !input.opts.threadTs;

const contradictsEnvThreadTs = (input: {
  readonly envTs: string | undefined;
  readonly isSameChannel: boolean;
  readonly threadTs: string | undefined;
}): boolean =>
  input.isSameChannel &&
  input.threadTs !== undefined &&
  isString(input.envTs) &&
  input.threadTs !== input.envTs;

/**
 * Resolve thread_ts for a same-channel or cross-channel post:
 * - `noThread`: short-circuits to a success carrying `undefined` before any other check.
 * - `guardCrossChannel`: returns a failure when posting cross-channel without an
 *   explicit `threadTs` (only enforced when a current channel is known via env).
 * - Same-channel conflict: returns a failure when `threadTs` doesn't match
 *   `$SLACK_THREAD_TS`.
 * - Auto-fill: returns `$SLACK_THREAD_TS` for same-channel posts when `threadTs`
 *   is omitted.
 *
 * When no env channel is known (the common case until env threading lands), the
 * cross-channel guard is inactive and an explicit `--channel` + `--thread-ts`
 * pair is honoured verbatim.
 */
export const resolveThreadTs = (
  channel: string,
  opts: {
    threadTs?: string | undefined;
    noThread?: boolean | undefined;
    guardCrossChannel?: boolean | undefined;
    env?: Record<string, string | undefined> | undefined;
  }
): Result.Result<string | undefined, Error> => {
  const { channel: currentChannel, threadTs: envTs } = getThreadContext(
    opts.env
  );
  const isSameChannel = isString(currentChannel) && channel === currentChannel;
  const blindCrossChannelPost = isBlindCrossChannelPost({
    currentChannel,
    isSameChannel,
    opts,
  });
  const contradictsEnvThread = contradictsEnvThreadTs({
    envTs,
    isSameChannel,
    threadTs: opts.threadTs,
  });

  if (opts.noThread) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Result.succeed needs an explicit arg to infer Result<string | undefined, Error>
    return Result.succeed(undefined);
  }
  if (blindCrossChannelPost) {
    return Result.fail(
      new Error(
        `Cross-channel post to ${channel} (current $SLACK_CHANNEL_ID=${currentChannel}) ` +
          "requires explicit threadTs or noThread=true."
      )
    );
  }
  if (contradictsEnvThread) {
    return Result.fail(
      new Error(
        `threadTs (${opts.threadTs}) does not match $SLACK_THREAD_TS (${envTs}). ` +
          "Omit threadTs to auto-use the current thread."
      )
    );
  }
  return Result.succeed(opts.threadTs ?? (isSameChannel ? envTs : undefined));
};

/**
 * Resolve a channel from an explicit flag, falling back to $SLACK_CHANNEL_ID.
 * Returns Err when neither is present so a command can fail with clear guidance.
 */
export const resolveChannel = (
  flagChannel: string | undefined,
  env: Record<string, string | undefined> = Bun.env
): Result.Result<string, Error> => {
  const channel = flagChannel ?? getThreadContext(env).channel;
  if (!channel) {
    return Result.fail(
      new Error(
        "No channel: pass --channel C123 (or set SLACK_CHANNEL_ID in the environment)."
      )
    );
  }
  return Result.succeed(channel);
};

/**
 * Validate that all required flags are present. Returns a failure listing the
 * missing flags plus a usage hint; callers propagate it to the CLI surface.
 */
export const requireFlags = (
  flags: Record<string, string>,
  command: string,
  ...required: readonly string[]
): Result.Result<void, Error> => {
  const missing = required.filter((name) => !flags[name]);
  if (missing.length > 0) {
    const missingList = missing.map((name) => `--${name}`).join(", ");
    const usage = required.map((name) => `--${name} <value>`).join(" ");
    return Result.fail(
      new Error(
        `${command}: missing required flag(s) ${missingList}. Usage: slack.ts ${command} ${usage}`
      )
    );
  }
  return Result.void;
};
