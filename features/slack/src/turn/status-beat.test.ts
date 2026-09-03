import { describe, expect, test } from "#src/test-support/index.ts";

import { initialRunState, withTool } from "#src/message-stream/run-state.ts";
import { readLiveLine, recordLiveLine } from "./live-line.ts";
import { beatLine, loadingListOf } from "./status-beat.ts";

const MINUTE = 60_000;

describe("the entry the reader sees in the thread", () => {
  test("cuts on a word boundary rather than mid-word", () => {
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
    const [entry] = loadingListOf("x".repeat(120));

    expect(entry?.length).toBeLessThanOrEqual(40);
    expect(entry?.endsWith("…")).toBe(true);
  });
});

describe("what the surface says on its own", () => {
  test("says the run is working before it has done anything", () => {
    expect(beatLine(initialRunState(1000), 1000)).toBe("working");
  });

  test("names the tools the run has actually touched", () => {
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
    const key = `slack:T1:C1:${crypto.randomUUID()}`;
    await recordLiveLine(key, "reading run-events.ts");

    expect(await readLiveLine(key)).toBe("reading run-events.ts");
  });

  test("the surface's, when the agent has said nothing at all", async () => {
    const key = `slack:T1:C1:${crypto.randomUUID()}`;

    expect(await readLiveLine(key)).toBeUndefined();
  });

  test("the surface's again once the agent's line is stale", async () => {
    const key = `slack:T1:C1:${crypto.randomUUID()}`;
    await recordLiveLine(key, "from a turn that is over");

    expect(await readLiveLine(key, Date.now() + 300_000)).toBeUndefined();
  });
});

describe("the slot the reader actually sees", () => {
  test("is filled, because Slack fills it with filler otherwise", () => {
    expect(loadingListOf("working · bash ×12 · 3m")).toEqual([
      "working · bash ×12 · 3m",
    ]);
  });

  test("carries one entry, not a carousel", () => {
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
