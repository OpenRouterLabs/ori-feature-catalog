/* oxlint-disable typescript/no-unsafe-type-assertion eslint/require-await -- fetch stubs stand in for the platform type, and a stub that answers from memory has nothing to await */
import { describe, expect, test } from "bun:test";

import type { QuestionsEnv } from "./post-questions.ts";

import { postQuestions } from "./post-questions.ts";

const THREAD: QuestionsEnv = {
  ORI_RUNTIME_PORT: "3141",
  SLACK_CHANNEL_ID: "C1",
  SLACK_THREAD_TS: "1.2",
};

const QUESTIONS = [
  {
    id: "q",
    prompt: "Which one?",
  },
];

const okFetch = (record?: (body: unknown) => void): typeof globalThis.fetch =>
  (async (_url: string, init?: { body?: string }) => {
    record?.(JSON.parse(init?.body ?? "{}"));
    return Response.json({
      ask_id: "a1",
      ok: true,
    });
  }) as unknown as typeof globalThis.fetch;

describe("the form is posted and the turn ends", () => {
  test("the thread comes from the env, never from the model", async () => {
    let body: unknown;

    const outcome = await postQuestions({
      env: THREAD,
      fetch: okFetch((seen) => {
        body = seen;
      }),
      intro: "Two things first.",
      questions: QUESTIONS,
    });

    expect(outcome).toEqual({ kind: "asked" });
    expect(body).toMatchObject({
      channel: "C1",
      thread_ts: "1.2",
    });
  });

  test("an intro with no questions is refused before any call", async () => {
    let called = false;

    const outcome = await postQuestions({
      env: THREAD,
      fetch: okFetch(() => {
        called = true;
      }),
      intro: "Two things first.",
      questions: [],
    });

    expect(outcome).toMatchObject({ kind: "error" });
    expect(called).toBe(false);
  });

  test("a blank expansion reads as absent, not as a channel", async () => {
    const outcome = await postQuestions({
      env: {
        SLACK_CHANNEL_ID: "C1",
        SLACK_THREAD_TS: "",
      },
      fetch: okFetch(),
      intro: "Two things first.",
      questions: QUESTIONS,
    });

    expect(outcome).toMatchObject({ kind: "error" });
    expect(outcome.kind === "error" && outcome.message).toContain(
      "no Slack thread in scope"
    );
  });
});

describe("a refusal is handed back for the model to act on", () => {
  test("the route's own reason survives, rather than a status code", async () => {
    const refusing = (async () =>
      new Response("every question needs its own id", {
        status: 400,
      })) as unknown as typeof globalThis.fetch;

    const outcome = await postQuestions({
      env: THREAD,
      fetch: refusing,
      intro: "Two things first.",
      questions: QUESTIONS,
    });

    expect(outcome.kind === "error" && outcome.message).toBe(
      "every question needs its own id"
    );
  });

  test("a dead daemon is reported rather than thrown", async () => {
    const dead = (() =>
      Promise.reject(
        new Error("ECONNREFUSED")
      )) as unknown as typeof globalThis.fetch;

    const outcome = await postQuestions({
      env: THREAD,
      fetch: dead,
      intro: "Two things first.",
      questions: QUESTIONS,
    });

    expect(outcome).toMatchObject({ kind: "error" });
  });
});
