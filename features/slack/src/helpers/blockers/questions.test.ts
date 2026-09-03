import { describe, expect, test } from "#src/test-support/index.ts";

import {
  askIdFromQuestionsCallback,
  blockIdFor,
  callbackFor,
  questionIdFromBlock,
  questionsBlocks,
  questionsModal,
} from "./questions.ts";

const asJson = (value: unknown): string => JSON.stringify(value);

describe("the form a batched ask becomes", () => {
  test("one input block per question, keyed so the answer finds its way back", () => {
    const modal = questionsModal({
      askId: "a1",
      intro: "Two things before I start.",
      questions: [
        {
          choices: ["volt", "grape"],
          id: "colour",
          prompt: "Which link colour?",
        },
        {
          id: "notes",
          prompt: "Anything else?",
          optional: true,
        },
      ],
    });

    expect(modal.blocks).toHaveLength(3);
    expect(asJson(modal.blocks)).toContain(blockIdFor("colour"));
    expect(asJson(modal.blocks)).toContain(blockIdFor("notes"));
    expect(modal.callbackId).toBe(callbackFor("a1"));
    expect(modal.submitLabel).toBe("Send");
  });

  test("choices become radio buttons, and multi becomes checkboxes", () => {
    const modal = questionsModal({
      askId: "a1",
      intro: "x",
      questions: [
        {
          choices: ["a", "b"],
          id: "one",
          prompt: "Pick one",
        },
        {
          choices: ["a", "b"],
          id: "many",
          kind: "multi",
          prompt: "Pick any",
        },
      ],
    });

    expect(asJson(modal.blocks)).toContain("radio_buttons");
    expect(asJson(modal.blocks)).toContain("checkboxes");
  });

  test("a question with no choices is a text box, not an empty radio group", () => {
    const modal = questionsModal({
      askId: "a1",
      intro: "x",
      questions: [
        {
          id: "why",
          prompt: "Why?",
        },
      ],
    });

    expect(asJson(modal.blocks)).toContain("plain_text_input");
  });

  test("the button says how many, because a reader postpones an unknown cost", () => {
    const blocks = questionsBlocks({
      askId: "a1",
      count: 3,
      intro: "Blocked on a few things.",
    });

    expect(asJson(blocks)).toContain("Answer 3 questions");
  });

  test("one question does not say 1 questions", () => {
    expect(
      asJson(
        questionsBlocks({
          askId: "a1",
          count: 1,
          intro: "x",
        })
      )
    ).toContain("Answer 1 question");
  });
});

describe("the ids that survive Slack's round trip", () => {
  test("a block id carries its question, and reads back", () => {
    expect(questionIdFromBlock(blockIdFor("colour"))).toBe("colour");
  });

  test("a callback id carries its ask, and reads back", () => {
    expect(askIdFromQuestionsCallback(callbackFor("a1"))).toBe("a1");
  });

  test("a separator inside the id survives, because the id is the model's", () => {
    expect(blockIdFor("scope|deep")).toBe("ori_q|scope|deep");
    expect(questionIdFromBlock(blockIdFor("scope|deep"))).toBe("scope|deep");
  });

  test("an empty id reads back as nothing, so its answer is dropped", () => {
    expect(questionIdFromBlock(blockIdFor(""))).toBeUndefined();
  });

  test("somebody else's ids are not ours", () => {
    expect(questionIdFromBlock("ori_blocker_answer")).toBeUndefined();
    expect(
      askIdFromQuestionsCallback("ori_blocker_freeform|a1")
    ).toBeUndefined();
  });
});

describe("model-authored text reaches Slack in Slack's dialect", () => {
  test("a GFM intro is converted, not printed with its asterisks showing", () => {
    const blocks = questionsBlocks({
      askId: "a1",
      count: 1,
      intro: "**Two things** — see [PR #12](https://example.com/12).",
    });
    const rendered = JSON.stringify(blocks);

    expect(rendered).not.toContain("**Two things**");
    expect(rendered).not.toContain("[PR #12]");
    expect(rendered).toContain("<https://example.com/12|PR #12>");
  });

  test("a broadcast in model text is escaped, not sent", () => {
    const rendered = JSON.stringify(
      questionsBlocks({
        askId: "a1",
        count: 1,
        intro: "ping <!channel>",
      })
    );

    expect(rendered).not.toContain("<!channel>");
    expect(rendered).toContain("&lt;!channel&gt;");
  });
});
