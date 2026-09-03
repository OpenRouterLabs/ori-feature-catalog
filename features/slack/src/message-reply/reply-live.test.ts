/* oxlint-disable typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/max-lines-per-function eslint/require-await eslint/no-unsafe-optional-chaining typescript/no-invalid-void-type promise/avoid-new promise/param-names unicorn/consistent-function-scoping -- test doubles assert on recorded `unknown` args and stand in for Slack SDK shapes; cases read better whole than split */
import type { ChatPostMessageArguments } from "@slack/web-api";

import { describe, expect, test } from "#src/test-support/index.ts";

import { Effect } from "effect";

import { makeFakeSlackClient } from "#src/client/client-test-support.ts";
import { makeMessageReply } from "#src/message-reply/index.ts";

const ref = {
  channelId: "C1",
  teamId: "T1",
  threadTs: "1700.0001",
};

const build = () =>
  Effect.gen(function* () {
    const fake = makeFakeSlackClient();
    const reply = yield* makeMessageReply(ref).pipe(Effect.provide(fake.layer));
    return {
      fake,
      reply,
    };
  });

describe("makeMessageReply", () => {
  test.effect("exposes the thread it is bound to", () =>
    Effect.gen(function* () {
      const { reply } = yield* build();

      expect(reply.ref).toEqual(ref);
    })
  );

  test.effect(
    "reply posts into the bound thread without the caller naming it",
    () =>
      Effect.gen(function* () {
        const { fake, reply } = yield* build();

        yield* reply.reply("hello");

        const args = fake.calls[0]?.args as ChatPostMessageArguments;
        expect(fake.calls[0]?.op).toBe("chat.postMessage");
        expect(args.channel).toBe("C1");
        expect(args.thread_ts).toBe("1700.0001");
      })
  );

  test.effect("markdown passes through untouched via markdown_text", () =>
    Effect.gen(function* () {
      const { fake, reply } = yield* build();
      const body = "**bold** and `code`\n- a list";

      yield* reply.reply(body);

      const args = fake.calls[0]?.args as { markdown_text?: string };
      expect(args.markdown_text).toBe(body);
    })
  );

  test.effect(
    "never sends text alongside markdown_text, which Slack rejects as markdown_text_conflict",
    () =>
      Effect.gen(function* () {
        const { fake, reply } = yield* build();

        yield* reply.reply("hello");

        expect((fake.calls[0]?.args as { text?: string }).text).toBeUndefined();
      })
  );

  test.effect("truncates rather than letting Slack reject a long answer", () =>
    Effect.gen(function* () {
      const { fake, reply } = yield* build();

      yield* reply.reply("x".repeat(60_000));

      const args = fake.calls[0]?.args as {
        markdown_text?: string;
        text?: string;
      };
      expect((args.markdown_text ?? "").length).toBeLessThanOrEqual(39_000);
      expect(args.markdown_text).toContain("truncated");
      expect(args.text).toBeUndefined();
    })
  );

  test.effect("leaves an ordinary-length answer untouched", () =>
    Effect.gen(function* () {
      const { fake, reply } = yield* build();

      yield* reply.reply("a normal answer");

      expect(
        (fake.calls[0]?.args as { markdown_text?: string }).markdown_text
      ).toBe("a normal answer");
    })
  );

  test.effect("caps blocks at Slack's per-message ceiling", () =>
    Effect.gen(function* () {
      const { fake, reply } = yield* build();
      const many = Array.from({ length: 80 }, () => ({ type: "section" }));

      yield* reply.replyBlocks(many, "fallback");

      expect(
        (fake.calls[0]?.args as { blocks?: readonly unknown[] }).blocks
      ).toHaveLength(50);
    })
  );

  test.effect("update edits the given ts in the bound channel", () =>
    Effect.gen(function* () {
      const { fake, reply } = yield* build();

      yield* reply.update("1700.9999", "edited");

      const args = fake.calls[0]?.args as { channel?: string; ts?: string };
      expect(fake.calls[0]?.op).toBe("chat.update");
      expect(args.channel).toBe("C1");
      expect(args.ts).toBe("1700.9999");
    })
  );

  test.effect("replyBlocks posts blocks with a notification fallback", () =>
    Effect.gen(function* () {
      const { fake, reply } = yield* build();
      const blocks = [{ type: "section" }];

      yield* reply.replyBlocks(blocks, "fallback text");

      const args = fake.calls[0]?.args as {
        blocks?: readonly unknown[];
        text?: string;
        thread_ts?: string;
      };
      expect(args.blocks).toEqual(blocks);
      expect(args.text).toBe("fallback text");
      expect(args.thread_ts).toBe("1700.0001");
    })
  );

  test.effect("updateBlocks rewrites a block message in place", () =>
    Effect.gen(function* () {
      const { fake, reply } = yield* build();

      yield* reply.updateBlocks("1700.5555", [{ type: "section" }], "done");

      const args = fake.calls[0]?.args as { ts?: string };
      expect(fake.calls[0]?.op).toBe("chat.update");
      expect(args.ts).toBe("1700.5555");
    })
  );

  test.effect("returns the posted channel and ts so callers can edit later", () =>
    Effect.gen(function* () {
      const { reply } = yield* build();

      const posted = yield* reply.reply("hi");

      expect(posted.ts).toBeTruthy();
      expect(posted.channel).toBeTruthy();
    })
  );

  test.effect("attach routes the file into the bound thread", () =>
    Effect.gen(function* () {
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
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const originalFetch = globalThis.fetch;
          globalThis.fetch = (() =>
            Promise.resolve(
              new Response("", { status: 200 })
            )) as unknown as typeof fetch;
          return originalFetch;
        }),
        (originalFetch) =>
          Effect.sync(() => {
            globalThis.fetch = originalFetch;
          })
      );

      const reply = yield* makeMessageReply(ref).pipe(
        Effect.provide(fake.layer)
      );
      const uploaded = yield* reply.attach(
        {
          content: "diff",
          filename: "a.patch",
        },
        "see this"
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
    })
  );
});
