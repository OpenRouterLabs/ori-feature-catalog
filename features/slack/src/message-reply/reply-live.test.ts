/* oxlint-disable import/no-relative-parent-imports typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/max-lines-per-function eslint/require-await eslint/no-unsafe-optional-chaining typescript/no-invalid-void-type promise/avoid-new promise/param-names unicorn/consistent-function-scoping -- test doubles assert on recorded `unknown` args and stand in for Slack SDK shapes; cases read better whole than split */
import type { ChatPostMessageArguments } from "@slack/web-api";

import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { makeFakeSlackClient } from "../client/client-test-support.ts";
import { makeMessageReply } from "./reply-live.ts";

const ref = {
  channelId: "C1",
  teamId: "T1",
  threadTs: "1700.0001",
};

const build = async () => {
  const fake = makeFakeSlackClient();
  const reply = await Effect.runPromise(
    makeMessageReply(ref).pipe(Effect.provide(fake.layer))
  );
  return {
    fake,
    reply,
  };
};

describe("makeMessageReply", () => {
  test("exposes the thread it is bound to", async () => {
    const { reply } = await build();

    expect(reply.ref).toEqual(ref);
  });

  test("reply posts into the bound thread without the caller naming it", async () => {
    const { fake, reply } = await build();

    await Effect.runPromise(reply.reply("hello"));

    const args = fake.calls[0]?.args as ChatPostMessageArguments;
    expect(fake.calls[0]?.op).toBe("chat.postMessage");
    expect(args.channel).toBe("C1");
    expect(args.thread_ts).toBe("1700.0001");
  });

  test("markdown passes through untouched via markdown_text", async () => {
    // Slack renders markdown natively, so there is no conversion layer to
    // keep in sync — the text arrives exactly as the agent produced it.
    const { fake, reply } = await build();
    const body = "**bold** and `code`\n- a list";

    await Effect.runPromise(reply.reply(body));

    const args = fake.calls[0]?.args as { markdown_text?: string };
    expect(args.markdown_text).toBe(body);
  });

  test("never sends text alongside markdown_text, which Slack rejects as markdown_text_conflict", async () => {
    const { fake, reply } = await build();

    await Effect.runPromise(reply.reply("hello"));

    expect((fake.calls[0]?.args as { text?: string }).text).toBeUndefined();
  });

  test("truncates rather than letting Slack reject a long answer", async () => {
    // Slack refuses an over-long message outright, so an uncapped reply turns
    // a long answer into no answer at all.
    const { fake, reply } = await build();

    await Effect.runPromise(reply.reply("x".repeat(60_000)));

    const args = fake.calls[0]?.args as {
      markdown_text?: string;
      text?: string;
    };
    expect((args.markdown_text ?? "").length).toBeLessThanOrEqual(39_000);
    expect(args.markdown_text).toContain("truncated");
    expect(args.text).toBeUndefined();
  });

  test("leaves an ordinary-length answer untouched", async () => {
    const { fake, reply } = await build();

    await Effect.runPromise(reply.reply("a normal answer"));

    expect(
      (fake.calls[0]?.args as { markdown_text?: string }).markdown_text
    ).toBe("a normal answer");
  });

  test("caps blocks at Slack's per-message ceiling", async () => {
    const { fake, reply } = await build();
    const many = Array.from({ length: 80 }, () => ({ type: "section" }));

    await Effect.runPromise(reply.replyBlocks(many, "fallback"));

    expect(
      (fake.calls[0]?.args as { blocks?: readonly unknown[] }).blocks
    ).toHaveLength(50);
  });

  test("update edits the given ts in the bound channel", async () => {
    const { fake, reply } = await build();

    await Effect.runPromise(reply.update("1700.9999", "edited"));

    const args = fake.calls[0]?.args as { channel?: string; ts?: string };
    expect(fake.calls[0]?.op).toBe("chat.update");
    expect(args.channel).toBe("C1");
    expect(args.ts).toBe("1700.9999");
  });

  test("replyBlocks posts blocks with a notification fallback", async () => {
    const { fake, reply } = await build();
    const blocks = [{ type: "section" }];

    await Effect.runPromise(reply.replyBlocks(blocks, "fallback text"));

    const args = fake.calls[0]?.args as {
      blocks?: readonly unknown[];
      text?: string;
      thread_ts?: string;
    };
    expect(args.blocks).toEqual(blocks);
    expect(args.text).toBe("fallback text");
    expect(args.thread_ts).toBe("1700.0001");
  });

  test("updateBlocks rewrites a block message in place", async () => {
    const { fake, reply } = await build();

    await Effect.runPromise(
      reply.updateBlocks("1700.5555", [{ type: "section" }], "done")
    );

    const args = fake.calls[0]?.args as { ts?: string };
    expect(fake.calls[0]?.op).toBe("chat.update");
    expect(args.ts).toBe("1700.5555");
  });

  test("returns the posted channel and ts so callers can edit later", async () => {
    const { reply } = await build();

    const posted = await Effect.runPromise(reply.reply("hi"));

    expect(posted.ts).toBeTruthy();
    expect(posted.channel).toBeTruthy();
  });

  test("attach routes the file into the bound thread", async () => {
    const fake = makeFakeSlackClient(
      {},
      {
        "files.completeUploadExternal": () => ({
          files: [
            {
              id: "F1",
              permalink: "https://slack/F1",
            },
          ],
        }),
        "files.getUploadURLExternal": () => ({
          file_id: "F1",
          upload_url: "https://upload.test/put",
        }),
      }
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("", { status: 200 })
      )) as unknown as typeof fetch;

    try {
      const reply = await Effect.runPromise(
        makeMessageReply(ref).pipe(Effect.provide(fake.layer))
      );
      const uploaded = await Effect.runPromise(
        reply.attach(
          {
            content: "diff",
            filename: "a.patch",
          },
          "see this"
        )
      );

      expect(uploaded.fileId).toBe("F1");
      const complete = fake.calls.find(
        (call) => call.op === "files.completeUploadExternal"
      );
      expect((complete?.args as { channel_id?: string }).channel_id).toBe("C1");
      expect((complete?.args as { thread_ts?: string }).thread_ts).toBe(
        "1700.0001"
      );
      expect(
        (complete?.args as { initial_comment?: string }).initial_comment
      ).toBe("see this");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
