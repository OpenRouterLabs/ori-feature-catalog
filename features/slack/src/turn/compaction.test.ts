import type { AgentRuntimeEvent } from "ori";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { initialRunState } from "../message-stream/run-state.ts";
import { beatLine } from "./status-beat.ts";
import { applyEvent } from "./run-events.ts";

const event = (type: string): AgentRuntimeEvent =>
  ({ payload: { trigger: "automatic" }, type }) as unknown as AgentRuntimeEvent;

const MINUTE = 60_000;

describe("compaction reaches the state", () => {
  test("a start is stamped, so the line can age it", () => {
    const state = applyEvent(initialRunState(0), event("compaction.started"));

    expect(state.compactingSince).toBeDefined();
  });

  test("a second start keeps the first stamp", () => {
    let state = applyEvent(initialRunState(0), event("compaction.started"));
    const first = state.compactingSince;
    state = applyEvent(state, event("compaction.started"));

    expect(state.compactingSince).toBe(first);
  });

  test.each([
    ["compaction.completed"],
    ["compaction.failed"],
    ["compaction.cancelled"],
  ])("%s clears it", (ending) => {
    let state = applyEvent(initialRunState(0), event("compaction.started"));
    state = applyEvent(state, event(ending));

    expect(state.compactingSince).toBeUndefined();
  });
});

describe("what the thread is told", () => {
  test("the line names the pause instead of freezing on the last tool", () => {
    const working = applyEvent(initialRunState(0), {
      payload: { name: "bash" },
      type: "tool.started",
    } as unknown as AgentRuntimeEvent);
    const compacting = applyEvent(working, event("compaction.started"));

    expect(beatLine(compacting, MINUTE)).toContain("compacting the context");
    expect(beatLine(compacting, MINUTE)).not.toContain("bash");
  });

  test("it says how long the pause has lasted, once there is a minute to say", () => {
    const state = {
      ...initialRunState(0),
      compactingSince: 0,
    };

    expect(beatLine(state, 0)).not.toContain("so far");
    expect(beatLine(state, 3 * MINUTE)).toContain("3m so far");
  });

  test("the tools come back when compaction ends", () => {
    let state = applyEvent(initialRunState(0), {
      payload: { name: "bash" },
      type: "tool.started",
    } as unknown as AgentRuntimeEvent);
    state = applyEvent(state, event("compaction.started"));
    state = applyEvent(state, event("compaction.completed"));

    expect(beatLine(state, MINUTE)).toContain("bash");
    expect(beatLine(state, MINUTE)).not.toContain("compacting");
  });

  test("total elapsed survives the pause", () => {
    const state = {
      ...initialRunState(0),
      compactingSince: 2 * MINUTE,
    };

    expect(beatLine(state, 5 * MINUTE)).toContain("5m");
  });
});
