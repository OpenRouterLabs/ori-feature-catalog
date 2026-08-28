/**
 * compaction.test.ts — the pause the surface used to sit through silently.
 *
 * Compaction is a model call that summarises the conversation so the run can
 * keep going. It emits no tool events while it runs, and the indicator is
 * built from tool events — so before this the line froze on whatever tool had
 * last finished, minutes ticking up beside it, which reads as a run that
 * stopped rather than one that is working.
 *
 * These cover the state transitions and the line, because that is the whole
 * feature: the daemon knows something the thread was not being told.
 */

import type { AgentRuntimeEvent } from "ori";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { initialRunState } from "../message-stream/run-state.ts";
import { beatLine } from "./indicator/index.ts";
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
    // Elapsed should mean "since the pause began", not "since the last event
    // about it" — otherwise a chatty harness resets the clock and the pause
    // always looks new.
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
    // Every ending, not just the happy one: a failed compaction leaves the run
    // working, and an indicator still claiming to compact is the stale line
    // this surface keeps relearning not to leave behind.
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
    // The tool summary is what the run did BEFORE the pause. Showing it while
    // nothing is happening is what made a stalled run look busy.
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
    // The turn's own age is the number a reader is actually waiting on; the
    // compaction clock is additional, not a replacement.
    const state = {
      ...initialRunState(0),
      compactingSince: 2 * MINUTE,
    };

    expect(beatLine(state, 5 * MINUTE)).toContain("5m");
  });
});
