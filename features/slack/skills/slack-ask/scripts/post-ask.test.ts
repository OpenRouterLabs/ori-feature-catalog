/* oxlint-disable typescript/no-unsafe-type-assertion typescript/no-base-to-string -- fetch stubs stand in for the platform type, and request bodies are inspected as the JSON they are */
import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { parseChoice, postAsk } from "./post-ask.ts";

const env = {
  ORI_RUNTIME_PORT: "4000",
  SLACK_CHANNEL_ID: "C1",
  SLACK_TEAM_ID: "T1",
  SLACK_THREAD_TS: "1700.1",
};

const answering = (body: unknown, status = 200) =>
  (() =>
    Promise.resolve(
      Response.json(body, { status })
    )) as unknown as typeof globalThis.fetch;

describe("parseChoice", () => {
  test("splits id from the label the reader sees", () => {
    expect(parseChoice("rebase=Rebase them")).toEqual({
      id: "rebase",
      label: "Rebase them",
    });
  });

  test("a bare word is both id and label", () => {
    expect(parseChoice("rebase")).toEqual({
      id: "rebase",
      label: "rebase",
    });
  });

  test("refuses a half-written pair rather than offering a blank button", () => {
    expect(parseChoice("=Rebase")).toBeUndefined();
    expect(parseChoice("rebase=")).toBeUndefined();
    expect(parseChoice("   ")).toBeUndefined();
  });
});

describe("postAsk", () => {
  test("sends the question and choices to the loopback ask route", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const outcome = await postAsk({
      choices: [
        {
          id: "rebase",
          label: "Rebase them",
        },
      ],
      env,
      fetch: ((url: string, init?: RequestInit) => {
        seen.push({
          body: JSON.parse(String(init?.body)),
          url,
        });
        return Promise.resolve(
          Response.json({
            answer: "rebase",
          })
        );
      }) as unknown as typeof globalThis.fetch,
      question: "Rebase or close?",
    });

    expect(outcome).toEqual({
      answer: "rebase",
      kind: "answered",
    });
    expect(seen[0]?.url).toBe("http://127.0.0.1:4000/slack/thread/ask");
    expect(seen[0]?.body).toEqual({
      channel: "C1",
      choices: [
        {
          id: "rebase",
          label: "Rebase them",
        },
      ],
      question: "Rebase or close?",
      team: "T1",
      thread_ts: "1700.1",
    });
  });

  test("nobody answering is an outcome, not a failure", async () => {
    const outcome = await postAsk({
      choices: [],
      env,
      fetch: answering({ error: "nobody answered" }, 408),
      question: "Rebase or close?",
    });

    expect(outcome.kind).toBe("unanswered");
  });

  test("refuses an empty question rather than posting a blank blocker", async () => {
    const outcome = await postAsk({
      choices: [],
      env,
      fetch: answering({}),
      question: "   ",
    });

    expect(outcome.kind).toBe("error");
  });

  test("reads coordinates from env so the model never restates them", async () => {
    const outcome = await postAsk({
      choices: [],
      env: {
        ...env,
        SLACK_THREAD_TS: "",
      },
      fetch: answering({}),
      question: "Rebase or close?",
    });

    expect(outcome.kind).toBe("error");
  });

  test("an unreachable daemon is an error, not a crash", async () => {
    const outcome = await postAsk({
      choices: [],
      env,
      fetch: (() =>
        Promise.reject(
          new Error("ECONNREFUSED")
        )) as unknown as typeof globalThis.fetch,
      question: "Rebase or close?",
    });

    expect(outcome.kind).toBe("error");
  });

  test("a 200 carrying no answer is an error, not an empty answer", async () => {
    const outcome = await postAsk({
      choices: [],
      env,
      fetch: answering({ ok: true }),
      question: "Rebase or close?",
    });

    expect(outcome.kind).toBe("error");
  });
});
