/* oxlint-disable typescript/no-unsafe-type-assertion -- the fake stands in for the Slack SDK shape */
import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { Effect } from "effect";

import type { AssistantThreadsShape } from "./assistant.ts";

import { makeFakeSlackClient, opsOf } from "#src/client/client-test-support.ts";
import { SlackClient } from "#src/client/client.ts";
import { AssistantThreadsLive, keyOf, titleFromMessage } from "./assistant.ts";

const PANE = {
  channelId: "D1",
  threadTs: "1700000000.000100",
};

const build = (
  overrides: Partial<Parameters<typeof makeFakeSlackClient>[0]> = {}
): Effect.Effect<{
  readonly assistant: AssistantThreadsShape;
  readonly fake: ReturnType<typeof makeFakeSlackClient>;
}> =>
  Effect.gen(function* () {
    const fake = makeFakeSlackClient(overrides as never);
    const assistant = yield* AssistantThreadsLive().pipe(
      Effect.provideService(SlackClient, fake.shape)
    );
    return {
      assistant,
      fake,
    };
  });

describe("AssistantThreadsLive", () => {
  test.effect("the title waits until the pane is known", () =>
    Effect.gen(function* () {
      const { assistant, fake } = yield* build();

      yield* assistant.setTitle(PANE, "a title");

      expect(opsOf(fake)).toEqual([]);
    })
  );

  test.effect("the status line is attempted everywhere, pane or not", () =>
    Effect.gen(function* () {
      const { assistant, fake } = yield* build();

      yield* assistant.setStatus(PANE, "working");

      expect(opsOf(fake)).toEqual(["assistant.threads.setStatus"]);
    })
  );
});

describe("AssistantThreadsLive, continued", () => {
  test.effect("once remembered, status and title reach Slack", () =>
    Effect.gen(function* () {
      const { assistant, fake } = yield* build();

      yield* assistant.remember(keyOf(PANE));
      yield* assistant.setStatus(PANE, "reading the PR");
      yield* assistant.setTitle(PANE, "triage the PRs");

      expect(opsOf(fake)).toEqual([
        "assistant.threads.setStatus",
        "assistant.threads.setTitle",
      ]);
      expect(fake.calls.at(0)?.args).toMatchObject({
        channel_id: "D1",
        status: "reading the PR",
        thread_ts: PANE.threadTs,
      });
    })
  );

  test.effect("a failed Slack call is warned about, never raised", () =>
    Effect.gen(function* () {
      const { assistant } = yield* build({
        setAssistantStatus: () => Effect.fail(new Error("not_allowed")) as never,
      });

      yield* assistant.remember(keyOf(PANE));

      expect(yield* assistant.setStatus(PANE, "working")).toBeUndefined();
    })
  );

  test.effect("the pane's conversation context is remembered and readable", () =>
    Effect.gen(function* () {
      const { assistant } = yield* build();

      yield* assistant.remember(keyOf(PANE), {
        channelId: "C_BEHIND",
        teamId: "T1",
      });

      expect(yield* assistant.contextFor(keyOf(PANE))).toEqual({
        channelId: "C_BEHIND",
        teamId: "T1",
      });
    })
  );

  test.effect(
    "re-remembering replaces the context, because the reader navigated",
    () =>
      Effect.gen(function* () {
        const { assistant } = yield* build();

        yield* assistant.remember(keyOf(PANE), {
          channelId: "C_FIRST",
          teamId: "T1",
        });
        yield* assistant.remember(keyOf(PANE), {
          channelId: "C_SECOND",
          teamId: "T1",
        });

        const current = yield* assistant.contextFor(keyOf(PANE));
        expect(current?.channelId).toBe("C_SECOND");
        expect(yield* assistant.isPane(keyOf(PANE))).toBe(true);
      })
  );

  test.effect("a pane with no context is still a pane", () =>
    Effect.gen(function* () {
      const { assistant } = yield* build();

      yield* assistant.remember(keyOf(PANE));

      expect(yield* assistant.isPane(keyOf(PANE))).toBe(true);
      expect(yield* assistant.contextFor(keyOf(PANE))).toBeUndefined();
    })
  );

  test.effect(
    "clearing the status sends an empty string, not a skipped call",
    () =>
      Effect.gen(function* () {
        const { assistant, fake } = yield* build();

        yield* assistant.remember(keyOf(PANE));
        yield* assistant.setStatus(PANE, "");

        expect(fake.calls.at(0)?.args).toMatchObject({ status: "" });
      })
  );

  test("the pane key does not carry a team id", () => {
    expect(keyOf(PANE)).toBe(`${PANE.channelId}:${PANE.threadTs}`);
  });
});

describe("titleFromMessage", () => {
  test("a short message becomes the title unchanged", () => {
    expect(titleFromMessage("triage the open PRs")).toBe("triage the open PRs");
  });

  test("collapses whitespace, so a pasted message is one line", () => {
    expect(titleFromMessage("  triage\n\n  the   PRs ")).toBe("triage the PRs");
  });

  test("truncates on a word boundary, because mid-word reads as a bug", () => {
    const title = titleFromMessage(
      "please go and rebase every conflicting pull request on the incubator repository right now"
    );

    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toContain("reposi…");
    expect(title.replace("…", "").endsWith(" ")).toBe(false);
  });

  test("an empty message yields an empty title rather than a stray ellipsis", () => {
    expect(titleFromMessage("   ")).toBe("");
  });

  test("a single unbroken word is still cut, rather than sent over the limit", () => {
    const title = titleFromMessage("x".repeat(200));

    expect(title.length).toBeLessThan(200);
    expect(title.endsWith("…")).toBe(true);
  });
});
