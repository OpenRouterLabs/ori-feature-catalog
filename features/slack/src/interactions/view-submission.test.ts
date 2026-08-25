/* oxlint-disable import/no-relative-parent-imports typescript/no-unsafe-type-assertion typescript/explicit-function-return-type -- fakes stand in for the Slack SDK shape */
/**
 * view-submission.test.ts — reading Slack's submitted-form body.
 *
 * The blocker's own modal is gone, so this covers the one modal left: the
 * questions form. The reading is shared, and it is the part that has broken
 * before — an unread element shape looks like a blank answer rather than an
 * unread one.
 */

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { readViewSubmissionPayload } from "../client/listeners.ts";
import { blockIdFor, callbackFor } from "../helpers/blockers/questions.ts";

/** Slack's real `view_submission` body, nested exactly as it arrives. */
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
