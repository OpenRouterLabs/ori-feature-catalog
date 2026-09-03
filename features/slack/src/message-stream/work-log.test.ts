/* oxlint-disable typescript/explicit-function-return-type -- the fixtures build states, and their shapes are inferred */
import { describe, expect, test } from "#src/test-support/index.ts";

import type { RunState } from "./run-state.ts";

import {
  initialRunState,
  renderRunState,
  renderWorkLog,
  RunPhase,
  withTool,
  appendLine,
} from "./run-state.ts";

const logged = (state: RunState, line: string, now?: number): RunState => ({
  ...state,
  ...appendLine(state, line, now),
});

const BUDGET = 6;
const CHARS_PER_VISUAL_LINE = 66;

const wrappedHeight = (rendered: string): number =>
  rendered
    .split("\n")
    .reduce(
      (total, line) =>
        total + Math.max(1, Math.ceil(line.length / CHARS_PER_VISUAL_LINE)),
      0
    );

const withProse = (
  state: ReturnType<typeof initialRunState>,
  prose: string
) => ({
  ...state,
  text: state.text + prose,
});

describe("the work log carries the agent's own words", () => {
  test("logs what it said, never the tool calls between", () => {
    let state = initialRunState(0);
    state = withProse(state, "Checking CI on the 9 red PRs.");
    state = withTool(state, "bash");
    state = withTool(state, "read");

    const rendered = renderWorkLog(state);

    expect(rendered).toContain("Checking CI on the 9 red PRs.");
    expect(rendered).not.toContain("bash");
    expect(rendered).not.toContain("read");
  });

  test("keeps a short tail, so Slack never collapses the message", () => {
    let state = initialRunState(0);
    for (let index = 0; index < 30; index += 1) {
      state = logged(state, `step-${index}`, index);
    }

    const rendered = renderWorkLog(state);

    expect(wrappedHeight(rendered)).toBeLessThanOrEqual(BUDGET);
    expect(rendered).toContain("step-29");
    expect(rendered).not.toContain("step-0\n");
  });

  test("budgets by wrapped height, not by number of entries", () => {
    const long = "x".repeat(200);
    let state = initialRunState(0);
    for (let index = 0; index < 10; index += 1) {
      state = logged(state, `${long}-${index}`, index);
    }

    const rendered = renderWorkLog(state);

    expect(wrappedHeight(rendered)).toBeLessThanOrEqual(BUDGET);
    expect(rendered.split("\n").length).toBeLessThan(3);
  });

  test("a restatement does not cost a line", () => {
    let state = initialRunState(0);
    state = logged(state, "Now I have the full picture. Writing the code.", 0);
    state = logged(state, "Now I have the full picture, writing the code!", 1);
    state = logged(state, "Wiring the App Home tab.", 2);

    expect(state.log).toHaveLength(2);
    expect(renderWorkLog(state)).toContain("Wiring the App Home tab.");
  });

  test("interleaves posted statuses with narration in order", () => {
    let state = initialRunState(0);
    state = logged(state, "Reviewing the 45 open PRs", 0);
    state = withProse(state, "20 of them conflict.");
    state = withTool(state, "bash");

    const lines = renderWorkLog(state).split("\n");

    expect(lines[0]).toContain("Reviewing the 45 open PRs");
    expect(lines[1]).toContain("20 of them conflict.");
  });

  test("flattens a multi-line block onto one line", () => {
    let state = withProse(initialRunState(0), "one\ntwo\nthree");
    state = withTool(state, "bash");

    expect(renderWorkLog(state).split("\n")).toHaveLength(1);
  });

  test("lets a normal sentence through untouched", () => {
    const sentence =
      "Found three dead entry points — App Home, the assistant pane, and reactions. Reading the turn path now.";
    let state = withProse(initialRunState(0), sentence);
    state = withTool(state, "bash");

    expect(renderWorkLog(state)).toBe(sentence);
  });

  test("caps a pasted wall, and never cuts a word in half", () => {
    const wall = `${"word ".repeat(200)}end`;
    let state = withProse(initialRunState(0), wall);
    state = withTool(state, "bash");
    const body = renderWorkLog(state).split("\n")[0] ?? "";

    expect(body.length).toBeLessThanOrEqual(301);
    expect(body.endsWith("…")).toBe(true);
    expect(body).not.toMatch(/wor…$/u);
  });

  test("shows the sentence still being written, so the text grows", () => {
    let state = withProse(initialRunState(0), "I'll take another");
    const early = renderWorkLog(state);
    state = withProse(state, " run at it — reviewing the repo.");

    expect(early).toBe("I'll take another…");
    expect(renderWorkLog(state)).toBe(
      "I'll take another run at it — reviewing the repo."
    );
  });

  test("does not repeat a block once the tool call closes it", () => {
    let state = withProse(initialRunState(0), "Checking CI.");
    state = withTool(state, "bash");

    expect(renderWorkLog(state)).toBe("Checking CI.");
  });

  test("windows a long in-flight line from the end, so it keeps moving", () => {
    const state = withProse(initialRunState(0), `${"x".repeat(400)}NEWEST`);
    const rendered = renderWorkLog(state);

    expect(rendered.endsWith("NEWEST…")).toBe(true);
    expect(rendered.startsWith("…")).toBe(true);
  });

  test("is plain prose, not a code block", () => {
    const state = logged(initialRunState(0), "Reviewing the PRs", 0);

    expect(renderWorkLog(state)).not.toContain("```");
    expect(renderWorkLog(state)).toBe("Reviewing the PRs");
  });

  test("renders nothing at all before the agent has said anything", () => {
    expect(renderWorkLog(initialRunState(0))).toBe("");
    expect(renderWorkLog(withTool(initialRunState(0), "bash"))).toBe("");
  });
});

describe("the window is fixed: the top scrolls off, the bottom keeps moving", () => {
  test("the in-flight line is paid for out of the same budget", () => {
    let state = initialRunState(0);
    for (let index = 0; index < 20; index += 1) {
      state = logged(state, `settled-${index}`, index);
    }
    state = withProse(state, "the sentence being written");

    expect(wrappedHeight(renderWorkLog(state))).toBeLessThanOrEqual(BUDGET);
  });

  test("the newest line is always last, and the oldest is what goes", () => {
    let state = initialRunState(0);
    for (const line of [
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
    ]) {
      state = logged(state, line, 0);
    }
    state = withProse(state, "still writing this");
    const lines = renderWorkLog(state).split("\n");

    expect(lines.at(-1)).toBe("still writing this…");
    expect(lines).not.toContain("one");
  });

  test("a single line longer than the whole budget still renders", () => {
    const state = withProse(initialRunState(0), "y".repeat(2000));

    expect(renderWorkLog(state)).not.toBe("");
  });
});

const worked = (): ReturnType<typeof initialRunState> => {
  let state = initialRunState(0);
  for (const line of ["Auditing the wiring", "Found three dead entry points"]) {
    state = logged(state, line, 0);
  }
  return state;
};

describe("an ending that is not an answer still reports the work", () => {
  test.each([RunPhase.TimedOut, RunPhase.Cancelled, RunPhase.Failed])(
    "%s carries what the run got done",
    (phase) => {
      const rendered = renderRunState({
        ...worked(),
        phase,
      });

      expect(rendered).toContain("What I got done");
      expect(rendered).toContain("Found three dead entry points");
    }
  );

  test("a run that did nothing says only how it ended", () => {
    const rendered = renderRunState({
      ...initialRunState(0),
      phase: RunPhase.TimedOut,
    });

    expect(rendered).toContain("Still running");
    expect(rendered).not.toContain("What I got done");
  });

  test("a successful turn reports the answer, not the narration", () => {
    const rendered = renderRunState({
      ...withProse(worked(), "Here is the answer."),
      phase: RunPhase.Done,
    });

    expect(rendered).toContain("Here is the answer.");
    expect(rendered).not.toContain("What I got done");
  });
});

describe("a sentence is never split across two log lines", () => {
  test("a tool call landing mid-sentence does not close the block", () => {
    let state = withProse(initialRunState(0), "Mapping the current tu");
    state = withTool(state, "bash");
    state = withProse(state, "rn path. Now the routes.");
    state = withTool(state, "read");

    expect(renderWorkLog(state)).toBe(
      "Mapping the current turn path. Now the routes."
    );
  });

  test("a completed sentence still closes, so the log advances", () => {
    let state = withProse(initialRunState(0), "Found the conflict.");
    state = withTool(state, "bash");
    state = withProse(state, "Rebasing now.");
    state = withTool(state, "bash");

    expect(renderWorkLog(state).split("\n")).toHaveLength(2);
  });

  test("an unfinished sentence is still visible while it is being written", () => {
    let state = withProse(initialRunState(0), "Mapping the current tu");
    state = withTool(state, "bash");

    expect(renderWorkLog(state)).toContain("Mapping the current tu");
  });
});
