/* oxlint-disable import/no-relative-parent-imports typescript/no-unsafe-type-assertion -- modules inside this feature import siblings relatively, and the recorded args are `unknown` */
/**
 * never-silent.test.ts — a turn always leaves the reader something.
 *
 * A steered turn posts nothing, on the reading that its replacement answers.
 * With no replacement that is just silence: the status line comes up, goes
 * down, and the thread has no reply and no way to tell it from a crash.
 */
import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { makeFakeSlackClient } from "../client/client-test-support.ts";
import { makeMessageReply } from "../message-reply/reply-live.ts";
import { initialRunState, RunPhase } from "./run-state.ts";
import { settle } from "./settle.ts";

const steered = {
  ...initialRunState(),
  phase: RunPhase.Steered,
  text: "half of an answer",
};

const posted = async (superseded: boolean): Promise<readonly string[]> => {
  const fake = makeFakeSlackClient();
  await Effect.runPromise(
    makeMessageReply({
      channelId: "C1",
      teamId: "T1",
      threadTs: "1700.1",
    }).pipe(
      Effect.flatMap((reply) =>
        settle({
          reply,
          state: steered,
          superseded,
        })
      ),
      Effect.provide(fake.layer)
    )
  );
  return fake.calls.map((call) => call.op);
};

describe("a steered turn", () => {
  test("stays quiet when something is queued to answer for it", async () => {
    expect(await posted(true)).toEqual([]);
  });

  test("answers anyway when nothing is", async () => {
    // Otherwise the reader is left with a status line that came and went.
    expect(await posted(false)).toContain("chat.postMessage");
  });
});
