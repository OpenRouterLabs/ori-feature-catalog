/**
 * settle.test.ts — the answer goes out in the dialect that renders tables.
 *
 * Slack has three markdown dialects and only one of them carries a table. A
 * `section` speaks Slack's own `mrkdwn` and `markdown_text` on
 * `chat.postMessage` is a third thing again; both drop tables silently, with
 * no error and no warning — the message posts, the table arrives as a run of
 * loose cells, and every test still passes.
 *
 * That is not hypothetical. A sibling intern shipped a recap whose table
 * rendered as flat text twice, and the fix both times was the transport, not
 * the markup. Nothing here pinned which block the answer uses, so the same
 * swap could land in this feature and be caught by a person reading a thread
 * rather than by CI.
 *
 * These tests are cheap and they only assert the one thing a reader cannot
 * see from the call site: that the answer block is `markdown`, and that a
 * table survives it intact.
 */

import { Effect } from "effect";

import type { SlackBlock } from "#src/helpers/block-kit/blocks.ts";
import type { MessageReplyShape } from "#src/message-reply/reply.ts";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { initialRunState, RunPhase } from "./run-state.ts";
import { settle } from "./settle.ts";

/** Captures what the turn tried to post, without a Slack client. */
const capture = () => {
  const posted: SlackBlock[][] = [];
  const reply = {
    replyBlocks: (blocks: readonly SlackBlock[]) => {
      posted.push([...blocks]);
      return Effect.succeed({ channel: "C1", ts: "1700.1" });
    },
  } as unknown as MessageReplyShape;
  return { posted, reply };
};

/** A finished turn whose prose is `answer`. `text` is what the answer renders from. */
const answered = (answer: string) => ({
  ...initialRunState(0),
  phase: RunPhase.Done,
  text: answer,
});

const TABLE = [
  "| Action | R | A |",
  "| --- | --- | --- |",
  "| Send the deck | Sarah | Katy |",
].join("\n");

describe("the answer's block type", () => {
  test.effect("is `markdown`, the only dialect that carries a table", () =>
    Effect.gen(function* () {
      const { posted, reply } = capture();

      yield* settle({
        now: 0,
        reply,
        state: answered("hi"),
        superseded: false,
      });

      const [blocks] = posted;
      expect(blocks?.[0]).toMatchObject({ type: "markdown" });
      // Named explicitly: `section` is the swap that silently drops tables.
      expect(blocks?.[0]).not.toMatchObject({ type: "section" });
    })
  );

  test.effect("a markdown table reaches Slack unaltered", () =>
    Effect.gen(function* () {
      const { posted, reply } = capture();

      yield* settle({
        now: 0,
        reply,
        state: answered(`Here is the split:\n\n${TABLE}`),
        superseded: false,
      });

      // The pipes and the delimiter row are the table. A dialect that cannot
      // render one mangles these rather than refusing, so asserting the text
      // survives is what distinguishes "rendered" from "posted as prose".
      const text = (posted[0]?.[0] as { text?: string } | undefined)?.text ?? "";
      expect(text).toContain("| --- | --- | --- |");
      expect(text).toContain("| Send the deck | Sarah | Katy |");
    })
  );
});
