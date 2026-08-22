/* oxlint-disable import/no-relative-parent-imports, typescript/explicit-function-return-type -- a test reaches across the feature for its fixtures, and typing every local helper buys nothing here */
import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import type { PendingForm } from "./questionnaires.ts";

import { makeFakeSlackClient } from "../client/client-test-support.ts";
import { blockIdFor, callbackFor } from "../helpers/blockers/questions.ts";
import { makeInteractions } from "./interactions.ts";
import { QuestionnairesMemory } from "./questionnaires.ts";
import {
  answersPrompt,
  registerQuestionHandlers,
} from "./questions-handler.ts";

const REF = {
  channelId: "C1",
  teamId: "T1",
  threadTs: "1700.1",
};

const FORM: PendingForm = {
  askId: "a1",
  intro: "Two things before I start.",
  messageTs: "1700.2",
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
  ref: REF,
};

/** A surface with the form already posted and waiting. */
const withForm = async (posted: PendingForm = FORM) => {
  const forms = await Effect.runPromise(QuestionnairesMemory);
  await Effect.runPromise(forms.put(posted));
  const interactions = makeInteractions();
  const started: { prompt: string; ref: typeof REF }[] = [];
  const fake = makeFakeSlackClient();

  registerQuestionHandlers({
    continueTurn: (form, prompt) => {
      started.push({
        prompt,
        ref: form.ref,
      });
    },
    forms,
    interactions,
    slack: fake.shape,
  });

  return {
    fake,
    forms,
    interactions,
    started,
  };
};

const submit = (values: ReadonlyMap<string, string>) => ({
  callbackId: callbackFor("a1"),
  userId: "U1",
  values,
});

describe("answering a form starts the next turn", () => {
  test("the answers arrive as a prompt, in the order they were asked", async () => {
    const surface = await withForm();

    await Effect.runPromise(
      surface.interactions.dispatchView(
        submit(
          new Map([
            [blockIdFor("notes"), "ship it"],
            [blockIdFor("colour"), "volt"],
          ])
        )
      )
    );

    expect(surface.started).toHaveLength(1);
    // Slack returns state.values in no guaranteed order; a list whose order
    // drifts from the questions leaves reader and model reading different
    // documents.
    const prompt = surface.started[0]?.prompt ?? "";
    expect(prompt.indexOf("Which link colour?")).toBeLessThan(
      prompt.indexOf("Anything else?")
    );
    expect(surface.started[0]?.ref).toEqual(REF);
  });

  test("the form is forgotten, so a second submit cannot start a second turn", async () => {
    const surface = await withForm();
    const payload = submit(new Map([[blockIdFor("colour"), "volt"]]));

    await Effect.runPromise(surface.interactions.dispatchView(payload));
    await Effect.runPromise(surface.interactions.dispatchView(payload));

    expect(surface.started).toHaveLength(1);
    expect(await Effect.runPromise(surface.forms.pending())).toBe(0);
  });

  test("the message loses its button and shows what was answered", async () => {
    const surface = await withForm();

    await Effect.runPromise(
      surface.interactions.dispatchView(
        submit(new Map([[blockIdFor("colour"), "volt"]]))
      )
    );

    expect(JSON.stringify(surface.fake.calls)).toContain("volt");
    expect(JSON.stringify(surface.fake.calls)).not.toContain(
      "Answer 2 questions"
    );
  });

  test("everything optional left blank starts nothing", async () => {
    // A turn that says nothing is worse than a thread that sits.
    const surface = await withForm();

    await Effect.runPromise(
      surface.interactions.dispatchView(submit(new Map()))
    );

    expect(surface.started).toHaveLength(0);
  });
});

describe("the prompt the next turn reads", () => {
  test("fences the answers, because a person typed them", () => {
    const prompt = answersPrompt([
      {
        answer: "volt",
        prompt: "Which link colour?",
      },
    ]);

    expect(prompt).toContain("<answers>");
    expect(prompt).toContain("</answers>");
    expect(prompt).toContain("Carry on from where you");
  });
});

describe("an id Slack's round trip cannot carry", () => {
  test("a separator in the id keeps the answer, because the id is the model's", async () => {
    // `blockIdFor` joins with `|`, and splitting on every separator brought
    // `scope|deep` back as `scope`, which matched no question: the person
    // answered, the message retired with their answer gone, and the turn that
    // would have read it never started.
    const surface = await withForm({
      ...FORM,
      questions: [
        {
          id: "scope|deep",
          prompt: "How deep should I go?",
        },
      ],
    });

    await Effect.runPromise(
      surface.interactions.dispatchView(
        submit(new Map([[blockIdFor("scope|deep"), "all the way"]]))
      )
    );

    expect(surface.started).toHaveLength(1);
    const echoed = JSON.stringify(surface.fake.calls);

    expect(echoed).toContain("all the way");
    expect(echoed).toContain("How deep should I go?");
  });

  test("an empty id loses its answer the same way", async () => {
    const surface = await withForm({
      ...FORM,
      questions: [
        {
          id: "",
          prompt: "Which one?",
        },
      ],
    });

    await Effect.runPromise(
      surface.interactions.dispatchView(
        submit(new Map([[blockIdFor(""), "the first"]]))
      )
    );

    expect(surface.started).toHaveLength(0);
    expect(JSON.stringify(surface.fake.calls)).not.toContain("the first");
  });
});
