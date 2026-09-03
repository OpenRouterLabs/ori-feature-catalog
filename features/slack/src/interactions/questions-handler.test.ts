/* oxlint-disable typescript/explicit-function-return-type -- a test reaches across the feature for its fixtures, and typing every local helper buys nothing here */
import { describe, expect, test } from "#src/test-support/index.ts";

import { Effect } from "effect";

import type { PendingForm } from "./questionnaires.ts";

import { makeFakeSlackClient } from "#src/client/client-test-support.ts";
import { blockIdFor, callbackFor } from "#src/helpers/blockers/questions.ts";
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

const withForm = (posted: PendingForm = FORM) =>
  Effect.gen(function* () {
    const forms = yield* QuestionnairesMemory;
    yield* forms.put(posted);
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
  });

const submit = (values: ReadonlyMap<string, string>) => ({
  callbackId: callbackFor("a1"),
  userId: "U1",
  values,
});

describe("answering a form starts the next turn", () => {
  test.effect("the answers arrive as a prompt, in the order they were asked", () =>
    Effect.gen(function* () {
      const surface = yield* withForm();

      yield* surface.interactions.dispatchView(
        submit(
          new Map([
            [blockIdFor("notes"), "ship it"],
            [blockIdFor("colour"), "volt"],
          ])
        )
      );

      expect(surface.started).toHaveLength(1);
      const prompt = surface.started[0]?.prompt ?? "";
      expect(prompt.indexOf("Which link colour?")).toBeLessThan(
        prompt.indexOf("Anything else?")
      );
      expect(surface.started[0]?.ref).toEqual(REF);
    })
  );

  test.effect("the form is forgotten, so a second submit cannot start a second turn", () =>
    Effect.gen(function* () {
      const surface = yield* withForm();
      const payload = submit(new Map([[blockIdFor("colour"), "volt"]]));

      yield* surface.interactions.dispatchView(payload);
      yield* surface.interactions.dispatchView(payload);

      expect(surface.started).toHaveLength(1);
      expect(yield* surface.forms.pending()).toBe(0);
    })
  );

  test.effect("the message loses its button and shows what was answered", () =>
    Effect.gen(function* () {
      const surface = yield* withForm();

      yield* surface.interactions.dispatchView(
        submit(new Map([[blockIdFor("colour"), "volt"]]))
      );

      expect(JSON.stringify(surface.fake.calls)).toContain("volt");
      expect(JSON.stringify(surface.fake.calls)).not.toContain(
        "Answer 2 questions"
      );
    })
  );

  test.effect("everything optional left blank starts nothing", () =>
    Effect.gen(function* () {
      const surface = yield* withForm();

      yield* surface.interactions.dispatchView(submit(new Map()));

      expect(surface.started).toHaveLength(0);
    })
  );
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
  test.effect("a separator in the id keeps the answer, because the id is the model's", () =>
    Effect.gen(function* () {
      const surface = yield* withForm({
        ...FORM,
        questions: [
          {
            id: "scope|deep",
            prompt: "How deep should I go?",
          },
        ],
      });

      yield* surface.interactions.dispatchView(
        submit(new Map([[blockIdFor("scope|deep"), "all the way"]]))
      );

      expect(surface.started).toHaveLength(1);
      const echoed = JSON.stringify(surface.fake.calls);

      expect(echoed).toContain("all the way");
      expect(echoed).toContain("How deep should I go?");
    })
  );

  test.effect("an empty id loses its answer the same way", () =>
    Effect.gen(function* () {
      const surface = yield* withForm({
        ...FORM,
        questions: [
          {
            id: "",
            prompt: "Which one?",
          },
        ],
      });

      yield* surface.interactions.dispatchView(
        submit(new Map([[blockIdFor(""), "the first"]]))
      );

      expect(surface.started).toHaveLength(0);
      expect(JSON.stringify(surface.fake.calls)).not.toContain("the first");
    })
  );
});
