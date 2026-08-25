/**
 * run-new.ts — the `new` subcommand workflow for the spawn-thread skill:
 * open a fresh top-level thread and dispatch into it atomically.
 *
 * Adapted for the ori Slack chat surface: no ori-monorepo egg /
 * skill-slack-render packages. Results use Effect's native `Result`;
 * buildSlackThreadUrl and the isString/tryCatchAsync re-exports are vendored in
 * ./guards.ts; the anchor + opener posts reuse its own postMessage/updateMessage
 * (moved here when slack-api became read-only). The loopback dispatch itself lives in
 * ./spawn-thread.ts.
 */

import { Option, Result } from "effect";

import type { KnownBlock } from "@slack/types";

import type { FetchLike } from "./spawn-thread.ts";

import { buildSlackThreadUrl, isString } from "./guards.ts";
import { postMessage } from "./post-message.ts";
import { dispatchToRunloop } from "./spawn-thread.ts";
import { updateMessage } from "./update-message.ts";

const ANCHOR_PLACEHOLDER_TEXT = ":link: _spawning a new thread…_";

export interface RunNewOpts {
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

/** Non-empty string that isn't the literal "undefined" env placeholder. */
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

  // When an anchor ts is supplied, use it as the message-level target so Slack
  // resolves the URL to "this reply inside this thread" — the form that
  // reliably triggers in-app thread-panel navigation.
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

/** Read the originating thread from env, treating "undefined" as absent. */
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

/**
 * Post the top-level opener message. `text` is the notification fallback; the
 * visual rendering is driven by `blocks`. Returns the new thread's ts.
 */
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

/**
 * Rewrite the anchor placeholder to link forward to the new thread, making the
 * link bidirectional. Best-effort: the caller swallows a failed update so it
 * never blocks the dispatch.
 */
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

/**
 * Dispatch into the freshly opened thread. On failure the opener is already
 * live in Slack but no agent run will happen there, so post a top-level
 * failure notice in the target channel to make the abandonment visible.
 * Best-effort — any notice-post error is swallowed so the caller still sees
 * the original dispatch error.
 */
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

export const runNew = async (
  opts: RunNewOpts
): Promise<Result.Result<SpawnedThread, Error>> => {
  const postFn = opts.postMessageImpl ?? postMessage;
  const updateFn = opts.updateMessageImpl ?? updateMessage;
  const origin = resolveOriginThread(opts.env);

  // When we have a real originating thread, post an anchor reply into
  // it BEFORE the opener. Capturing this anchor's ts lets the opener's backlink
  // button target a specific reply (the form Slack reliably opens as a thread
  // side-panel). Best-effort: if it fails we fall back to a parent-ts URL.
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
