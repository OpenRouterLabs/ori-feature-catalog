/* oxlint-disable import/no-relative-parent-imports typescript/no-unsafe-type-assertion -- siblings are imported relatively, and the fake stands in for the Slack SDK shape */
import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import type { AssistantThreadsShape } from "./assistant.ts";

import { makeFakeSlackClient, opsOf } from "../client/client-test-support.ts";
import { SlackClient } from "../client/client.ts";
import { AssistantThreadsLive, keyOf, titleFromMessage } from "./assistant.ts";

const PANE = {
  channelId: "D1",
  threadTs: "1700000000.000100",
};

const build = async (
  overrides: Partial<Parameters<typeof makeFakeSlackClient>[0]> = {}
): Promise<{
  readonly assistant: AssistantThreadsShape;
  readonly fake: ReturnType<typeof makeFakeSlackClient>;
}> => {
  const fake = makeFakeSlackClient(overrides as never);
  const assistant = await Effect.runPromise(
    AssistantThreadsLive().pipe(Effect.provideService(SlackClient, fake.shape))
  );
  return {
    assistant,
    fake,
  };
};

describe("AssistantThreadsLive", () => {
  test("the title waits until the pane is known", async () => {
    const { assistant, fake } = await build();

    await Effect.runPromise(assistant.setTitle(PANE, "a title"));

    // Slack answers `not_allowed` for these outside an assistant container, so
    // the surface has to know it is in one rather than trying and ignoring.
    expect(opsOf(fake)).toEqual([]);
  });

  test("the status line is attempted everywhere, pane or not", async () => {
    // It is the only working indicator a channel agent gets — Devin renders
    // exactly this under the composer of a channel thread. Refusal is a logged
    // warning, so trying costs one call and nothing else.
    const { assistant, fake } = await build();

    await Effect.runPromise(assistant.setStatus(PANE, "working"));

    expect(opsOf(fake)).toEqual(["assistant.threads.setStatus"]);
  });
});

describe("AssistantThreadsLive, continued", () => {
  test("once remembered, status and title reach Slack", async () => {
    const { assistant, fake } = await build();

    await Effect.runPromise(assistant.remember(keyOf(PANE)));
    await Effect.runPromise(assistant.setStatus(PANE, "reading the PR"));
    await Effect.runPromise(assistant.setTitle(PANE, "triage the PRs"));

    expect(opsOf(fake)).toEqual([
      "assistant.threads.setStatus",
      "assistant.threads.setTitle",
    ]);
    expect(fake.calls.at(0)?.args).toMatchObject({
      channel_id: "D1",
      status: "reading the PR",
      thread_ts: PANE.threadTs,
    });
  });

  test("a failed Slack call is warned about, never raised", async () => {
    const { assistant } = await build({
      // The port declares `SlackApiError`; a plain Error is enough to prove the
      // failure is caught, and `orDie`-free typing keeps the double honest.
      setAssistantStatus: () => Effect.fail(new Error("not_allowed")) as never,
    });

    await Effect.runPromise(assistant.remember(keyOf(PANE)));

    // These are decoration around a turn running regardless — failing the run
    // here would trade the answer for a label.
    await expect(
      Effect.runPromise(assistant.setStatus(PANE, "working"))
    ).resolves.toBeUndefined();
  });

  test("the pane's conversation context is remembered and readable", async () => {
    const { assistant } = await build();

    await Effect.runPromise(
      assistant.remember(keyOf(PANE), {
        channelId: "C_BEHIND",
        teamId: "T1",
      })
    );

    // The pane is its own conversation, so without this "summarise this" has
    // no referent but the question itself.
    expect(await Effect.runPromise(assistant.contextFor(keyOf(PANE)))).toEqual({
      channelId: "C_BEHIND",
      teamId: "T1",
    });
  });

  test("re-remembering replaces the context, because the reader navigated", async () => {
    const { assistant } = await build();

    await Effect.runPromise(
      assistant.remember(keyOf(PANE), {
        channelId: "C_FIRST",
        teamId: "T1",
      })
    );
    await Effect.runPromise(
      assistant.remember(keyOf(PANE), {
        channelId: "C_SECOND",
        teamId: "T1",
      })
    );

    const current = await Effect.runPromise(assistant.contextFor(keyOf(PANE)));
    expect(current?.channelId).toBe("C_SECOND");
    // Still a pane: membership is what makes the pane-only calls legal, and a
    // context change must not revoke that.
    expect(await Effect.runPromise(assistant.isPane(keyOf(PANE)))).toBe(true);
  });

  test("a pane with no context is still a pane", async () => {
    const { assistant } = await build();

    await Effect.runPromise(assistant.remember(keyOf(PANE)));

    expect(await Effect.runPromise(assistant.isPane(keyOf(PANE)))).toBe(true);
    expect(
      await Effect.runPromise(assistant.contextFor(keyOf(PANE)))
    ).toBeUndefined();
  });

  test("clearing the status sends an empty string, not a skipped call", async () => {
    const { assistant, fake } = await build();

    await Effect.runPromise(assistant.remember(keyOf(PANE)));
    await Effect.runPromise(assistant.setStatus(PANE, ""));

    // Slack shows the indicator until it is cleared, so a skipped clear leaves
    // the pane thinking next to an answer that already arrived.
    expect(fake.calls.at(0)?.args).toMatchObject({ status: "" });
  });

  test("the pane key does not carry a team id", () => {
    // Panes only ever exist in the installed workspace, and the callers here
    // have a channel and a thread but not always a team.
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
    // Whole words only: the cut lands on a space, never inside one.
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
