import { WebClient } from "@slack/web-api";
import { Result } from "effect";
import { slackifyMarkdown } from "slackify-markdown";

import { isString } from "./result.ts";

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

const presentEnv = (raw: string | undefined): string | undefined =>
  raw && raw !== "undefined" ? raw : undefined;

export const getThreadContext = (
  env: Record<string, string | undefined> = Bun.env
): {
  channel: string | undefined;
  threadTs: string | undefined;
} => ({
  channel: presentEnv(env.SLACK_CHANNEL_ID),
  threadTs: presentEnv(env.SLACK_THREAD_TS),
});

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
