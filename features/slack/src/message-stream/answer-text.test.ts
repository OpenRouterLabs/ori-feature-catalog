import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { answerText } from "./answer-text.ts";
import { initialRunState } from "./run-state.ts";

describe("an answer for a run that ended on a tool call", () => {
  test("falls back to the last thing it said, never to nothing", () => {
    const state = {
      ...initialRunState(),
      log: ["Reading the PR list", "Eight are green and ready to merge"],
      logged: 2,
    };

    expect(answerText(state)).toBe("Eight are green and ready to merge");
  });
});
