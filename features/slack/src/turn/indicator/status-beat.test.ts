/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively */
import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { initialRunState, withTool } from "../../message-stream/run-state.ts";
import { readLiveLine, recordLiveLine } from "./live-line.ts";
import { beatLine, loadingListOf } from "./status-beat.ts";

const MINUTE = 60_000;

describe("the entry the reader sees in the thread", () => {
  test("cuts on a word boundary rather than mid-word", () => {
    // `cloning OpenRouterIncubator/ori to revi…` is what a mid-word cut looks
    // like in a thread, and it reads as a rendering bug rather than a summary.
    const [entry] = loadingListOf(
      "cloning OpenRouterIncubator/ori to review P0 issues"
    );

    expect(entry).toBe("cloning OpenRouterIncubator/ori to…");
    expect(entry?.replace("…", "").endsWith(" ")).toBe(false);
  });

  test("a line that already fits is left alone", () => {
    expect(loadingListOf("rebasing the 7 conflicting PRs")).toEqual([
      "rebasing the 7 conflicting PRs",
    ]);
  });

  test("one unbroken token is still cut, because over the budget is refused", () => {
    // Slack rejects the whole list when an entry is too long, and a rejected
    // list costs the slot entirely — Slack then cycles its own filler.
    const [entry] = loadingListOf("x".repeat(120));

    expect(entry?.length).toBeLessThanOrEqual(40);
    expect(entry?.endsWith("…")).toBe(true);
  });
});

describe("what the surface says on its own", () => {
  test("says the run is working before it has done anything", () => {
    // The failure this replaces: four minutes into a real run the thread
    // still showed "is starting up…", because the only thing that could
    // update it was the model, and the model never called anything.
    expect(beatLine(initialRunState(1000), 1000)).toBe("working");
  });

  test("names the tools the run has actually touched", () => {
    // Built from what the daemon already folds, so it is true whether or not
    // the agent has said a word.
    const state = withTool(withTool(initialRunState(0), "bash"), "bash");

    expect(beatLine(state, 0)).toBe("working · bash ×2");
  });

  test("counts the minutes, so a stuck run is distinguishable from a fast one", () => {
    const state = withTool(initialRunState(0), "read");

    expect(beatLine(state, 3 * MINUTE)).toBe("working · read · 3m");
  });

  test("stays on one line, because Slack never folds it", () => {
    let state = initialRunState(0);
    for (const tool of Array.from({ length: 40 }, (_, i) => `tool-${i}`)) {
      state = withTool(state, tool);
    }

    const line = beatLine(state, 0);

    expect(line.length).toBeLessThanOrEqual(80);
    expect(line).toEndWith("…");
  });
});

describe("whose words end up on the indicator", () => {
  test("the agent's, when it has said something recently", async () => {
    // It knows what it is doing; the surface only knows which tools ran.
    const key = `slack:T1:C1:${crypto.randomUUID()}`;
    await recordLiveLine(key, "reading run-events.ts");

    expect(await readLiveLine(key)).toBe("reading run-events.ts");
  });

  test("the surface's, when the agent has said nothing at all", async () => {
    // The four-minute silence this whole thing exists to prevent: no line to
    // re-assert, so the beat renders its own rather than leaving it dead.
    const key = `slack:T1:C1:${crypto.randomUUID()}`;

    expect(await readLiveLine(key)).toBeUndefined();
  });

  test("the surface's again once the agent's line is stale", async () => {
    // A line older than the window belongs to a turn that has ended, and
    // re-asserting it would put a finished run's words on a live thread.
    const key = `slack:T1:C1:${crypto.randomUUID()}`;
    await recordLiveLine(key, "from a turn that is over");

    expect(await readLiveLine(key, Date.now() + 300_000)).toBeUndefined();
  });
});

describe("the slot the reader actually sees", () => {
  test("is filled, because Slack fills it with filler otherwise", () => {
    // Omitting `loading_messages` does not leave it blank: Slack cycles
    // "Gathering information…" into the thread, which is true of every run
    // and about none. That is what it showed when this was dropped.
    expect(loadingListOf("working · bash ×12 · 3m")).toEqual([
      "working · bash ×12 · 3m",
    ]);
  });

  test("carries one entry, not a carousel", () => {
    // Slack rotates any list it is given, so the last ten lines read as work
    // the run had already moved on from.
    expect(loadingListOf("reading run-events.ts")).toHaveLength(1);
  });

  test("is shorter than the line, because the list is rejected whole", () => {
    const [entry] = loadingListOf(
      "tracing where AgentFailure is exported from and why CI disagrees"
    );

    expect(entry?.length).toBeLessThanOrEqual(40);
    expect(entry).toEndWith("…");
  });
});
