import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { readViewSubmissionPayload } from "#src/client/listeners.ts";
import { blockIdFor, callbackFor } from "#src/helpers/blockers/questions.ts";

const submission = (askId: string, typed: string): unknown => ({
  type: "view_submission",
  user: { id: "U1" },
  view: {
    callback_id: callbackFor(askId),
    state: {
      values: {
        [blockIdFor("q1")]: {
          ori_questions_input: {
            type: "plain_text_input",
            value: typed,
          },
        },
      },
    },
  },
});

describe("readViewSubmissionPayload", () => {
  test("flattens Slack's block/action nesting to the value", () => {
    const payload = readViewSubmissionPayload(
      submission("ask-4", "Close them")
    );

    expect(payload.callbackId).toBe(callbackFor("ask-4"));
    expect(payload.values.get(blockIdFor("q1"))).toBe("Close them");
  });

  test("a body it cannot read yields nothing rather than throwing", () => {
    const payload = readViewSubmissionPayload(null);

    expect(payload.callbackId).toBe("");
    expect(payload.values.size).toBe(0);
  });
});
