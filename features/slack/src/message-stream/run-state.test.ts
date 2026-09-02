import { describe, expect, test } from "#src/test-support/effect-test.ts";

import type { RunState } from "./run-state.ts";

import {
  RunPhase,
  initialRunState,
  renderRunState,
  renderStatusLine,
  withTool,
  appendLine,
} from "./run-state.ts";

const logged = (state: RunState, line: string, now?: number): RunState => ({
  ...state,
  ...appendLine(state, line, now),
});

const MINUTE = 60_000;

const withProse = (
  state: ReturnType<typeof initialRunState>,
  prose: string
) => ({
  ...state,
  text: state.text + prose,
});

describe("the answer is the last thing the agent said", () => {
  test("interstitial narration between tool calls is not the answer", () => {
    let state = initialRunState(0);
    state = withProse(state, "Let me look at the PR queue.");
    state = withTool(state, "bash");
    state = withProse(state, "Now checking CI.");
    state = withTool(state, "bash");
    state = withProse(state, "20 PRs are blocked on a conflict.");

    const rendered = renderRunState({
      ...state,
      phase: RunPhase.Done,
    });

    expect(rendered).toContain("20 PRs are blocked on a conflict.");
    expect(rendered).not.toContain("Let me look at the PR queue.");
    expect(rendered).not.toContain("Now checking CI.");
  });

  test("a run whose last act was a tool call still answers", () => {
    let state = initialRunState(0);
    state = withProse(state, "Here is the queue.");
    state = withTool(state, "slack-chart");

    const rendered = renderRunState({
      ...state,
      phase: RunPhase.Done,
    });

    expect(rendered).toContain("Here is the queue.");
  });

  test("a failure still reports the prose the run got to", () => {
    let state = initialRunState(0);
    state = withProse(state, "Got halfway.");
    state = withTool(state, "bash");

    const rendered = renderRunState({
      ...state,
      error: "the harness died",
      phase: RunPhase.Failed,
    });

    expect(rendered).toContain("Got halfway.");
    expect(rendered).toContain("the harness died");
  });
});

describe("the progress line proves the run is alive", () => {
  test("does not count elapsed minutes — Slack already timestamps it", () => {
    const state = {
      ...initialRunState(0),
      phase: RunPhase.Running,
    };

    expect(renderStatusLine(state, 3 * MINUTE)).toBe(
      renderStatusLine(state, 30_000)
    );
  });

  test("a run that never says anything is still flagged as quiet", () => {
    const state = {
      ...initialRunState(0),
      phase: RunPhase.Running,
    };

    expect(renderStatusLine(state, 3 * MINUTE)).not.toContain("quiet");
    expect(renderStatusLine(state, 9 * MINUTE)).toContain("quiet for 9m");
    expect(renderStatusLine(state, 9 * MINUTE)).not.toEqual(
      renderStatusLine(state, 10 * MINUTE)
    );
  });

  test("says so when the agent's own status has gone stale", () => {
    const state = logged(
      {
        ...initialRunState(0),
        phase: RunPhase.Running,
      },
      "Reviewing the 45 open PRs",
      MINUTE
    );

    expect(renderStatusLine(state, 3 * MINUTE)).not.toContain("quiet for");
    expect(renderStatusLine(state, 9 * MINUTE)).toContain("quiet for 8m");
    expect(renderStatusLine(state, 9 * MINUTE)).not.toContain(
      "Reviewing the 45 open PRs"
    );
  });

  test("a queued run says why, with no counter to imply work", () => {
    const rendered = renderStatusLine(
      {
        ...initialRunState(0),
        phase: RunPhase.Queued,
      },
      9 * MINUTE
    );

    expect(rendered).toContain("Queued");
    expect(rendered).not.toContain("9m");
  });

  test("a run that has not reported yet says it is starting, not queued", () => {
    const rendered = renderStatusLine(initialRunState(0), 0);

    expect(rendered).toContain("Starting up");
    expect(rendered).not.toContain("Queued");
  });
});

describe("timed out", () => {
  test("reads as a timeout, never as a cancellation", () => {
    const rendered = renderRunState({
      ...initialRunState(),
      phase: RunPhase.TimedOut,
      text: "partial",
    });

    expect(rendered).toContain("Still running");
    expect(rendered).not.toContain("Cancelled");
    expect(rendered).not.toContain("Stopped waiting");
    expect(rendered).toContain("partial");
  });
});

describe("renderRunState never renders nothing", () => {
  test.each([
    RunPhase.Cancelled,
    RunPhase.Done,
    RunPhase.Failed,
    RunPhase.Queued,
    RunPhase.Running,
    RunPhase.TimedOut,
  ])("%s produces text Slack will accept", (phase) => {
    const rendered = renderRunState({
      ...initialRunState(),
      phase,
    });

    expect(rendered.trim()).not.toBe("");
  });

  test("a turn that finishes having said nothing still says so", () => {
    const rendered = renderRunState({
      ...initialRunState(),
      phase: RunPhase.Done,
    });

    expect(rendered).toContain("no output");
  });
});

describe("initialRunState", () => {
  test("starts up with nothing accumulated", () => {
    const state = initialRunState();

    expect(state.phase).toBe(RunPhase.Starting);
    expect(state.text).toBe("");
    expect(state.tools.size).toBe(0);
    expect(state.error).toBeUndefined();
  });

  test("returns a fresh map each time", () => {
    const first = initialRunState();
    withTool(first, "bash");

    expect(initialRunState().tools.size).toBe(0);
  });
});

describe("withTool", () => {
  test("records a first invocation", () => {
    expect(withTool(initialRunState(), "bash").tools.get("bash")).toBe(1);
  });

  test("counts repeats of the same tool", () => {
    const twice = withTool(withTool(initialRunState(), "bash"), "bash");

    expect(twice.tools.get("bash")).toBe(2);
  });

  test("does not mutate the state it was given", () => {
    const before = initialRunState();
    withTool(before, "bash");

    expect(before.tools.size).toBe(0);
  });
});

describe("renderRunState", () => {
  test("queued explains why nothing is happening yet", () => {
    const rendered = renderRunState({
      ...initialRunState(),
      phase: RunPhase.Queued,
    });

    expect(rendered).toContain("Queued");
    expect(rendered).toContain("current run in this thread");
  });

  test("running with no output yet still shows life", () => {
    const rendered = renderRunState({
      ...initialRunState(),
      phase: RunPhase.Running,
    });

    expect(rendered).toContain("Working");
  });

  test("running never names the tools it ran", () => {
    const rendered = renderRunState({
      ...withTool(withTool(initialRunState(), "bash"), "read"),
      phase: RunPhase.Running,
    });

    expect(rendered).not.toContain("bash");
    expect(rendered).not.toContain("read");
    expect(rendered).toContain("Working");
  });

  test("running keeps prose above the status line", () => {
    const rendered = renderRunState({
      ...initialRunState(),
      phase: RunPhase.Running,
      text: "partial answer",
    });

    expect(rendered.indexOf("partial answer")).toBeLessThan(
      rendered.indexOf("Working")
    );
  });

  test("done renders the answer and the model, but no tool names", () => {
    const rendered = renderRunState({
      ...withTool(initialRunState(), "bash"),
      model: "opus",
      phase: RunPhase.Done,
      text: "the answer",
    });

    expect(rendered).toContain("the answer");
    expect(rendered).toContain("opus");
    expect(rendered).not.toContain("bash");
  });

  test("done with no footer detail is just the answer", () => {
    expect(
      renderRunState({
        ...initialRunState(),
        phase: RunPhase.Done,
        text: "the answer",
      })
    ).toBe("the answer");
  });

  test("cancelled marks the partial output as stopped", () => {
    const rendered = renderRunState({
      ...initialRunState(),
      phase: RunPhase.Cancelled,
      text: "half an answer",
    });

    expect(rendered).toContain("half an answer");
    expect(rendered).toContain("Cancelled");
  });

  test("failed states the reason it was given", () => {
    const rendered = renderRunState({
      ...initialRunState(),
      error: "provider timed out",
      phase: RunPhase.Failed,
    });

    expect(rendered).toContain("provider timed out");
  });

  test("failed without a reason still reads as an ending, not progress", () => {
    const rendered = renderRunState({
      ...initialRunState(),
      phase: RunPhase.Failed,
    });

    expect(rendered).toContain("Failed");
    expect(rendered).not.toContain("Working");
  });
});

describe("the footer names what ran the turn", () => {
  test("the harness leads, the model follows", () => {
    const rendered = renderRunState({
      ...initialRunState(),
      harness: "pi",
      model: "anthropic/claude-opus-latest",
      phase: RunPhase.Done,
      text: "done",
    });

    expect(rendered).toContain("pi · anthropic/claude-opus-latest");
  });

  test("a run that never named one says nothing about it", () => {
    const rendered = renderRunState({
      ...initialRunState(),
      model: "anthropic/claude-opus-latest",
      phase: RunPhase.Done,
      text: "done",
    });

    expect(rendered).toContain("anthropic/claude-opus-latest");
    expect(rendered).not.toContain(" · anthropic");
  });
});

describe("the small print under an answer", () => {
  test("names what ran it, and not how many times a shell did", () => {
    const rendered = renderRunState({
      ...initialRunState(),
      harness: "pi",
      model: "anthropic/claude-opus-latest",
      phase: RunPhase.Done,
      text: "done",
      tools: new Map([["bash", 23]]),
    });

    expect(rendered).toContain("pi · anthropic/claude-opus-latest");
    expect(rendered).not.toContain("bash");
  });
});
