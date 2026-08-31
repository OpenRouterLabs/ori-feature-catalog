import { Result } from "effect";

import type { FetchLike } from "#skills/spawn-thread/scripts/spawn-thread.ts";

import { postMessage } from "#skills/spawn-thread/scripts/post-message.ts";
import { openThread } from "#skills/spawn-thread/scripts/run-new.ts";
import { resolveHttpPort } from "#skills/spawn-thread/scripts/spawn-thread.ts";
import { updateMessage } from "#skills/spawn-thread/scripts/update-message.ts";

export interface CarriedThread {
  readonly channel: string;
  readonly sessionId: string;
  readonly thread_ts: string;
}

interface OriginThread {
  readonly channel: string;
  readonly threadTs: string;
}

const present = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0 && value !== "undefined";

const resolveOrigin = (
  env: Record<string, string | undefined>
): OriginThread | undefined => {
  const channel = env.SLACK_CHANNEL_ID;
  const threadTs = env.SLACK_THREAD_TS;
  return present(channel) && present(threadTs)
    ? { channel, threadTs }
    : undefined;
};

const movedNotice = (channel: string, newThreadTs: string): string =>
  `:arrow_right: _Continued in <https://slack.com/archives/${channel}/p${newThreadTs.replace(".", "")}|the new thread>. This thread is muted — reply over there._`;

const carryOnRunloop = async (input: {
  readonly env: Record<string, string | undefined>;
  readonly fetchImpl?: FetchLike | undefined;
  readonly origin: OriginThread;
  readonly toThreadTs: string;
}): Promise<Result.Result<string, Error>> => {
  const port = resolveHttpPort(input.env);
  const fetchFn = input.fetchImpl ?? fetch;
  try {
    const response = await fetchFn(
      `http://127.0.0.1:${port}/slack/thread/carry`,
      {
        body: JSON.stringify({
          channel: input.origin.channel,
          thread_ts: input.origin.threadTs,
          to_thread_ts: input.toThreadTs,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "no body");
      return Result.fail(
        new Error(`carry rejected (HTTP ${response.status}): ${detail}`)
      );
    }
    const body = (await response.json()) as { sessionId?: string };
    return Result.succeed(body.sessionId ?? "");
  } catch (cause) {
    return Result.fail(new Error(`carry request failed: ${String(cause)}`));
  }
};

export const runCarry = async (opts: {
  readonly env: Record<string, string | undefined>;
  readonly fetchImpl?: FetchLike | undefined;
  readonly opener: string;
  readonly postMessageImpl?: typeof postMessage | undefined;
  readonly updateMessageImpl?: typeof updateMessage | undefined;
}): Promise<Result.Result<CarriedThread, Error>> => {
  const origin = resolveOrigin(opts.env);
  if (origin === undefined) {
    return Result.fail(
      new Error(
        "no thread to carry: SLACK_CHANNEL_ID / SLACK_THREAD_TS are not set"
      )
    );
  }

  const opened = await openThread({
    channel: origin.channel,
    env: opts.env,
    opener: opts.opener,
    postMessageImpl: opts.postMessageImpl,
    updateMessageImpl: opts.updateMessageImpl,
  });
  if (Result.isFailure(opened)) {
    return Result.fail(opened.failure);
  }
  const newThreadTs = opened.success;

  const carried = await carryOnRunloop({
    env: opts.env,
    fetchImpl: opts.fetchImpl,
    origin,
    toThreadTs: newThreadTs,
  });
  if (Result.isFailure(carried)) {
    await (opts.postMessageImpl ?? postMessage)({
      channel: origin.channel,
      text: `:warning: _Could not move this conversation: ${carried.failure.message}_`,
      threadTs: origin.threadTs,
    });
    return Result.fail(carried.failure);
  }

  await (opts.postMessageImpl ?? postMessage)({
    channel: origin.channel,
    text: movedNotice(origin.channel, newThreadTs),
    threadTs: origin.threadTs,
  });

  return Result.succeed({
    channel: origin.channel,
    sessionId: carried.success,
    thread_ts: newThreadTs,
  });
};
