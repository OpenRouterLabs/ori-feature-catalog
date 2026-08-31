import { Option, Result } from "effect";

import type { KnownBlock } from "@slack/types";

import type { FetchLike } from "./spawn-thread.ts";

import { isString } from "#skills/slack-api/scripts/result.ts";
import { buildSlackThreadUrl } from "./guards.ts";
import { postMessage } from "./post-message.ts";
import { dispatchToRunloop } from "./spawn-thread.ts";
import { updateMessage } from "./update-message.ts";

const ANCHOR_PLACEHOLDER_TEXT = ":link: _spawning a new thread…_";

interface RunNewOpts {
  channel: string;
  opener: string;
  prompt: string;
  depth: number;
  env: Record<string, string | undefined>;
  postMessageImpl?: typeof postMessage | undefined;
  updateMessageImpl?: typeof updateMessage | undefined;
  fetchImpl?: FetchLike | undefined;
}

const buildAnchorFinalText = (newThreadUrl: string): string =>
  `:link: <${newThreadUrl}|spawned thread>`;

const isPresentEnvValue = (value: unknown): value is string =>
  isString(value) && value.length > 0 && value !== "undefined";

const postAnchorPlaceholder = async (
  postFn: typeof postMessage,
  originChannel: string,
  originThreadTs: string
): Promise<string | undefined> => {
  const anchorResult = await postFn({
    channel: originChannel,
    threadTs: originThreadTs,
    text: ANCHOR_PLACEHOLDER_TEXT,
  });
  if (Result.isFailure(anchorResult)) {
    return undefined;
  }
  return Option.getOrUndefined(
    Option.map(anchorResult.success, ({ ts }) => ts)
  );
};

export const buildOpenerBlocks = ({
  opener,
  originChannel,
  originTs,
  anchorTs,
}: {
  opener: string;
  originChannel: string | undefined;
  originTs: string | undefined;
  anchorTs?: string | undefined;
}): KnownBlock[] => {
  const sectionBlock: KnownBlock = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: opener,
    },
  };

  const hasBacklinkContext =
    isPresentEnvValue(originChannel) && isPresentEnvValue(originTs);
  if (!hasBacklinkContext) {
    return [sectionBlock];
  }

  const backlinkUrl = buildSlackThreadUrl({
    channel: originChannel,
    threadTs: originTs,
    messageTs: isPresentEnvValue(anchorTs) ? anchorTs : undefined,
  });
  const actionsBlock: KnownBlock = {
    type: "actions",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "View originating thread",
          emoji: true,
        },
        url: backlinkUrl,
        action_id: "spawn_thread_backlink",
      },
    ],
  };

  return [sectionBlock, actionsBlock];
};

interface OriginThread {
  readonly channel: string;
  readonly threadTs: string;
}

const resolveOriginThread = (
  env: Record<string, string | undefined>
): OriginThread | undefined => {
  const channel = env.SLACK_CHANNEL_ID;
  const threadTs = env.SLACK_THREAD_TS;
  if (isPresentEnvValue(channel) && isPresentEnvValue(threadTs)) {
    return {
      channel,
      threadTs,
    };
  }
  return undefined;
};

interface PostOpenerArgs {
  readonly postFn: typeof postMessage;
  readonly channel: string;
  readonly opener: string;
  readonly blocks: readonly KnownBlock[];
}

const postOpener = async (
  args: PostOpenerArgs
): Promise<Result.Result<string, Error>> => {
  const postResult = await args.postFn({
    channel: args.channel,
    text: args.opener,
    blocks: args.blocks,
    noThread: true,
  });

  if (Result.isFailure(postResult)) {
    return Result.fail(
      new Error(`opener post failed: ${postResult.failure.message}`)
    );
  }

  return Result.fromOption(
    Option.map(postResult.success, ({ ts }) => ts),
    () => new Error("opener post returned no thread_ts — cannot dispatch")
  );
};

interface RewriteAnchorArgs {
  readonly updateFn: typeof updateMessage;
  readonly origin: OriginThread;
  readonly anchorTs: string;
  readonly targetChannel: string;
  readonly newThreadTs: string;
}

const rewriteAnchorToNewThread = async (
  args: RewriteAnchorArgs
): Promise<void> => {
  const newThreadUrl = buildSlackThreadUrl({
    channel: args.targetChannel,
    threadTs: args.newThreadTs,
  });
  await args.updateFn({
    channel: args.origin.channel,
    ts: args.anchorTs,
    text: buildAnchorFinalText(newThreadUrl),
  });
};

export interface SpawnedThread {
  readonly channel: string;
  readonly thread_ts: string;
}

interface DispatchNewThreadArgs {
  readonly postFn: typeof postMessage;
  readonly opts: RunNewOpts;
  readonly newTs: string;
}

const dispatchNewThread = async (
  args: DispatchNewThreadArgs
): Promise<Result.Result<void, Error>> => {
  const dispatchResult = await dispatchToRunloop({
    channel: args.opts.channel,
    threadTs: args.newTs,
    message: args.opts.prompt,
    depth: args.opts.depth,
    env: args.opts.env,
    fetchImpl: args.opts.fetchImpl,
  });
  if (Result.isFailure(dispatchResult)) {
    await args.postFn({
      channel: args.opts.channel,
      noThread: true,
      text: `:x: Spawn-thread dispatch failed for ${args.newTs}: ${dispatchResult.failure.message}`,
    });
  }
  return dispatchResult;
};

export const openThread = async (opts: {
  channel: string;
  opener: string;
  env: Record<string, string | undefined>;
  postMessageImpl?: typeof postMessage | undefined;
  updateMessageImpl?: typeof updateMessage | undefined;
}): Promise<Result.Result<string, Error>> => {
  const postFn = opts.postMessageImpl ?? postMessage;
  const updateFn = opts.updateMessageImpl ?? updateMessage;
  const origin = resolveOriginThread(opts.env);

  const anchorTs = origin
    ? await postAnchorPlaceholder(postFn, origin.channel, origin.threadTs)
    : undefined;

  const blocks = buildOpenerBlocks({
    opener: opts.opener,
    originChannel: opts.env.SLACK_CHANNEL_ID,
    originTs: opts.env.SLACK_THREAD_TS,
    anchorTs,
  });

  const openerResult = await postOpener({
    postFn,
    channel: opts.channel,
    opener: opts.opener,
    blocks,
  });
  if (Result.isFailure(openerResult)) {
    return Result.fail(openerResult.failure);
  }
  const newTs = openerResult.success;

  if (anchorTs && origin) {
    await rewriteAnchorToNewThread({
      updateFn,
      origin,
      anchorTs,
      targetChannel: opts.channel,
      newThreadTs: newTs,
    });
  }

  return Result.succeed(newTs);
};

export const runNew = async (
  opts: RunNewOpts
): Promise<Result.Result<SpawnedThread, Error>> => {
  const postFn = opts.postMessageImpl ?? postMessage;
  const opened = await openThread(opts);
  if (Result.isFailure(opened)) {
    return Result.fail(opened.failure);
  }
  const newTs = opened.success;

  const dispatchResult = await dispatchNewThread({
    postFn,
    opts,
    newTs,
  });
  if (Result.isFailure(dispatchResult)) {
    return Result.fail(dispatchResult.failure);
  }

  return Result.succeed({
    channel: opts.channel,
    thread_ts: newTs,
  });
};
