import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { answerText } from "./answer-text.ts";
import { initialRunState } from "./run-state.ts";

describe("an answer for a run that ended on a tool call", () => {
  test("falls back to the last thing it said, never to nothing", () => {
    // The agent narrated, posted a chart and stopped. There was no prose left
    // to be the answer, so the message ended as cards over a blank body.
    const state = {
      ...initialRunState(),
      log: ["Reading the PR list", "Eight are green and ready to merge"],
      logged: 2,
    };

    expect(answerText(state)).toBe("Eight are green and ready to merge");
  });
});
