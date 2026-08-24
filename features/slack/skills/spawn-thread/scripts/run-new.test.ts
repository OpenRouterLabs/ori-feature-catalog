/* oxlint-disable typescript/no-unsafe-type-assertion -- block payloads are typed `unknown[]` at the seam and are inspected as the Block Kit they are */
import { describe, expect, test } from "bun:test";

import type { KnownBlock } from "@slack/types";
import { Option, Result } from "effect";

import type { PostMessageResponse } from "./post-message.ts";

import type { FetchLike } from "./spawn-thread.ts";

import { buildOpenerBlocks, runNew } from "./run-new.ts";

interface PostCall {
  readonly blocks?: readonly KnownBlock[] | undefined;
  readonly channel: string;
  readonly noThread?: boolean | undefined;
  readonly text?: string | undefined;
  readonly threadTs?: string | undefined;
}

interface UpdateCall {
  readonly channel: string;
  readonly text: string;
  readonly ts: string;
}

const ORIGIN = {
  SLACK_CHANNEL_ID: "C-ORIGIN",
  SLACK_THREAD_TS: "1700.1",
};

const NEW_TS = "1800.2";

interface Harness {
  readonly posts: PostCall[];
  readonly updates: UpdateCall[];
}

/**
 * A Slack that hands back a ts for every post. `tsFor` lets a test decide what
 * each successive post returns, which is how the anchor and the opener are
 * told apart.
 */
/** What the boundary-decoded postMessage hands back: `None` = Slack sent no ts. */
type PostReply = Result.Result<Option.Option<PostMessageResponse>, Error>;

const harness = (
  replies: readonly PostReply[]
): Harness & {
  readonly postMessageImpl: (opts: PostCall) => Promise<PostReply>;
  readonly updateMessageImpl: (opts: UpdateCall) => Promise<PostReply>;
} => {
  const posts: PostCall[] = [];
  const updates: UpdateCall[] = [];
  return {
    postMessageImpl: (opts) => {
      posts.push(opts);
      return Promise.resolve(
        replies[posts.length - 1] ?? Result.succeed(Option.some({ ts: NEW_TS }))
      );
    },
    posts,
    updateMessageImpl: (opts) => {
      updates.push(opts);
      return Promise.resolve(Result.succeed(Option.none()));
    },
    updates,
  };
};

const acceptingDaemon: FetchLike = () =>
  Promise.resolve(new Response("", { status: 202 }));

const backlinkUrl = (blocks: readonly KnownBlock[]): string | undefined => {
  const actions = blocks.find(
    (block) => (block as { type?: string }).type === "actions"
  ) as { elements?: { url?: string }[] } | undefined;
  return actions?.elements?.[0]?.url;
};

describe("buildOpenerBlocks", () => {
  test("is a bare section when there is no originating thread", () => {
    // A spawn started from a cron run or the CLI has nothing to link back to,
    // and a button to nowhere is worse than no button.
    const blocks = buildOpenerBlocks({
      opener: "Looking at the outage",
      originChannel: undefined,
      originTs: undefined,
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      text: {
        text: "Looking at the outage",
        type: "mrkdwn",
      },
      type: "section",
    });
  });

  test("adds a backlink button when the origin is known", () => {
    const blocks = buildOpenerBlocks({
      opener: "Looking at the outage",
      originChannel: "C-ORIGIN",
      originTs: "1700.1",
    });

    expect(blocks).toHaveLength(2);
    expect(backlinkUrl(blocks)).toBe(
      "https://openrouter.slack.com/archives/C-ORIGIN/p17001?thread_ts=1700.1&cid=C-ORIGIN"
    );
  });

  test("points the backlink at the anchor reply when there is one", () => {
    const blocks = buildOpenerBlocks({
      anchorTs: "1750.9",
      opener: "Looking at the outage",
      originChannel: "C-ORIGIN",
      originTs: "1700.1",
    });

    expect(backlinkUrl(blocks)).toContain("/p17509?");
    expect(backlinkUrl(blocks)).toContain("thread_ts=1700.1");
  });

  test("treats the literal string \"undefined\" as no origin at all", () => {
    // An unset env var expanded by a shell arrives as the four-letter word,
    // and a link built from it 404s.
    expect(
      buildOpenerBlocks({
        opener: "hi",
        originChannel: "undefined",
        originTs: "undefined",
      })
    ).toHaveLength(1);
  });
});

describe("runNew", () => {
  test("anchors the origin thread before opening the new one", async () => {
    // Order matters: the anchor's ts is what the opener's backlink points at,
    // so it has to exist before the opener is built.
    const slack = harness([
      Result.succeed(Option.some({ ts: "1750.9" })),
      Result.succeed(Option.some({ ts: NEW_TS })),
    ]);

    const result = await runNew({
      channel: "C-TARGET",
      depth: 0,
      env: ORIGIN,
      fetchImpl: acceptingDaemon,
      opener: "Looking at the outage",
      postMessageImpl: slack.postMessageImpl,
      prompt: "find the cause",
      updateMessageImpl: slack.updateMessageImpl,
    });

    expect(result).toEqual(
      Result.succeed({
        channel: "C-TARGET",
        thread_ts: NEW_TS,
      })
    );
    expect(slack.posts[0]).toMatchObject({
      channel: "C-ORIGIN",
      threadTs: "1700.1",
    });
    expect(slack.posts[1]).toMatchObject({
      channel: "C-TARGET",
      noThread: true,
      text: "Looking at the outage",
    });
    expect(backlinkUrl(slack.posts[1]?.blocks ?? [])).toContain("/p17509?");
  });

  test("rewrites the anchor to point forward at the thread it spawned", async () => {
    const slack = harness([
      Result.succeed(Option.some({ ts: "1750.9" })),
      Result.succeed(Option.some({ ts: NEW_TS })),
    ]);

    await runNew({
      channel: "C-TARGET",
      depth: 0,
      env: ORIGIN,
      fetchImpl: acceptingDaemon,
      opener: "Looking at the outage",
      postMessageImpl: slack.postMessageImpl,
      prompt: "find the cause",
      updateMessageImpl: slack.updateMessageImpl,
    });

    expect(slack.updates).toHaveLength(1);
    expect(slack.updates[0]).toMatchObject({
      channel: "C-ORIGIN",
      ts: "1750.9",
    });
    expect(slack.updates[0]?.text).toContain(
      "https://openrouter.slack.com/archives/C-TARGET/p18002"
    );
  });

  test("opens the thread anyway when the anchor could not be posted", async () => {
    // The anchor is a courtesy; losing it must not cost the run. The opener
    // then falls back to a root-ts backlink.
    const slack = harness([
      Result.fail(new Error("ratelimited")),
      Result.succeed(Option.some({ ts: NEW_TS })),
    ]);

    const result = await runNew({
      channel: "C-TARGET",
      depth: 0,
      env: ORIGIN,
      fetchImpl: acceptingDaemon,
      opener: "Looking at the outage",
      postMessageImpl: slack.postMessageImpl,
      prompt: "find the cause",
      updateMessageImpl: slack.updateMessageImpl,
    });

    expect(Result.isSuccess(result)).toBe(true);
    expect(backlinkUrl(slack.posts[1]?.blocks ?? [])).toContain("/p17001?");
    expect(slack.updates).toBeEmpty();
  });

  test("skips the anchor entirely when there is no origin thread", async () => {
    const slack = harness([Result.succeed(Option.some({ ts: NEW_TS }))]);

    await runNew({
      channel: "C-TARGET",
      depth: 0,
      env: {},
      fetchImpl: acceptingDaemon,
      opener: "Looking at the outage",
      postMessageImpl: slack.postMessageImpl,
      prompt: "find the cause",
      updateMessageImpl: slack.updateMessageImpl,
    });

    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]?.channel).toBe("C-TARGET");
  });

  test("stops when the opener could not be posted", async () => {
    let dispatched = false;
    const slack = harness([Result.fail(new Error("channel_not_found"))]);

    const result = await runNew({
      channel: "C-TARGET",
      depth: 0,
      env: {},
      fetchImpl: () => {
        dispatched = true;
        return Promise.resolve(new Response("", { status: 202 }));
      },
      opener: "Looking at the outage",
      postMessageImpl: slack.postMessageImpl,
      prompt: "find the cause",
      updateMessageImpl: slack.updateMessageImpl,
    });

    expect(Result.isFailure(result) && result.failure.message).toBe(
      "opener post failed: channel_not_found"
    );
    expect(dispatched).toBe(false);
  });

  test("refuses to dispatch when Slack returned no ts to dispatch into", async () => {
    // Dispatching with an empty thread_ts would enqueue a turn against a
    // thread that does not exist, and the run would vanish.
    const slack = harness([Result.succeed(Option.none())]);

    const result = await runNew({
      channel: "C-TARGET",
      depth: 0,
      env: {},
      fetchImpl: acceptingDaemon,
      opener: "Looking at the outage",
      postMessageImpl: slack.postMessageImpl,
      prompt: "find the cause",
      updateMessageImpl: slack.updateMessageImpl,
    });

    expect(Result.isFailure(result) && result.failure.message).toContain(
      "no thread_ts"
    );
  });

  test("says so in the channel when the opener is live but nothing will run", async () => {
    // The thread is already visible to everyone in the channel. Failing
    // silently leaves an opener nobody is working on.
    const slack = harness([Result.succeed(Option.some({ ts: NEW_TS }))]);

    const result = await runNew({
      channel: "C-TARGET",
      depth: 0,
      env: {},
      fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
      opener: "Looking at the outage",
      postMessageImpl: slack.postMessageImpl,
      prompt: "find the cause",
      updateMessageImpl: slack.updateMessageImpl,
    });

    expect(Result.isFailure(result) && result.failure.message).toContain(
      "dispatch request failed"
    );
    expect(slack.posts).toHaveLength(2);
    expect(slack.posts[1]).toMatchObject({
      channel: "C-TARGET",
      noThread: true,
    });
    expect(slack.posts[1]?.text).toContain(NEW_TS);
  });
});
