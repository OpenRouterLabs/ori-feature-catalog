/* oxlint-disable typescript/no-unsafe-type-assertion -- test doubles stand in for Slack SDK and fetch shapes */

import { Option, Result } from "effect";

import { describe, expect, test } from "#src/test-support/index.ts";

import { MAX_FORK, parseThreads, runFork } from "./run-fork.ts";

const ENV = {
  ORI_HTTP_PORT: "7070",
  SLACK_CHANNEL_ID: "C1",
  SLACK_THREAD_TS: "1700.1",
};

const THREADS = [
  { opener: "Thread 1: identity", prompt: "talk about identity" },
  { opener: "Thread 2: scale", prompt: "talk about scale" },
];

const bench = (options: { readonly failOpeners?: readonly string[] } = {}) => {
  const posted: string[] = [];
  let nextTs = 100;
  return {
    fetchImpl: ((): Promise<Response> =>
      Promise.resolve(new Response("{}", { status: 200 }))) as never,
    posted,
    postMessageImpl: ((input: {
      channel: string;
      text: string;
      threadTs?: string;
    }): Promise<Result.Result<Option.Option<{ ts: string }>, Error>> => {
      if ((options.failOpeners ?? []).some((bad) => input.text.includes(bad))) {
        return Promise.resolve(Result.fail(new Error("slack said no")));
      }
      posted.push(input.text);
      nextTs += 1;
      return Promise.resolve(
        Result.succeed(Option.some({ ts: `18${nextTs}.5` }))
      );
    }) as never,
    updateMessageImpl: ((): Promise<Result.Result<void, Error>> =>
      Promise.resolve(Result.void)) as never,
  };
};

describe("parsing a fork request", () => {
  test("reads a list of openers and prompts", () => {
    const parsed = parseThreads(JSON.stringify(THREADS));

    expect(Result.isSuccess(parsed) && parsed.success).toHaveLength(2);
  });

  test.each([
    ["missing", undefined],
    ["empty", ""],
    ["not JSON", "{{{"],
    ["not an array", '{"opener":"a","prompt":"b"}'],
    ["an empty array", "[]"],
  ])("%s is refused", (_label, raw) => {
    expect(Result.isFailure(parseThreads(raw))).toBe(true);
  });

  test.each([
    ["no opener", '[{"prompt":"b"}]'],
    ["no prompt", '[{"opener":"a"}]'],
    ["a blank opener", '[{"opener":"   ","prompt":"b"}]'],
  ])("a thread with %s is refused", (_label, raw) => {
    expect(Result.isFailure(parseThreads(raw))).toBe(true);
  });

  test("more threads than the cap is refused, naming the cap", () => {
    const many = Array.from({ length: MAX_FORK + 1 }, (_, index) => ({
      opener: `Thread ${index}`,
      prompt: "go",
    }));

    const parsed = parseThreads(JSON.stringify(many));

    expect(Result.isFailure(parsed)).toBe(true);
    expect(Result.isFailure(parsed) && parsed.failure.message).toContain(
      String(MAX_FORK)
    );
  });
});

describe("opening them", () => {
  test("every requested thread is opened", async () => {
    const harness = bench();

    const report = await runFork({
      channel: "C1",
      depth: 0,
      env: ENV,
      fetchImpl: harness.fetchImpl,
      postMessageImpl: harness.postMessageImpl,
      threads: THREADS,
      updateMessageImpl: harness.updateMessageImpl,
    });

    expect(report.created).toHaveLength(2);
    expect(report.failed).toHaveLength(0);
  });

  test("they are opened in the order they were asked for", async () => {
    const harness = bench();

    await runFork({
      channel: "C1",
      depth: 0,
      env: ENV,
      fetchImpl: harness.fetchImpl,
      postMessageImpl: harness.postMessageImpl,
      threads: THREADS,
      updateMessageImpl: harness.updateMessageImpl,
    });

    const first = harness.posted.findIndex((text) => text.includes("identity"));
    const second = harness.posted.findIndex((text) => text.includes("scale"));
    expect(first).toBeLessThan(second);
  });

  test("one failure does not abandon the others", async () => {
    const harness = bench({ failOpeners: ["Thread 2"] });

    const report = await runFork({
      channel: "C1",
      depth: 0,
      env: ENV,
      fetchImpl: harness.fetchImpl,
      postMessageImpl: harness.postMessageImpl,
      threads: THREADS,
      updateMessageImpl: harness.updateMessageImpl,
    });

    expect(report.created).toHaveLength(1);
    expect(report.failed).toHaveLength(1);
  });

  test("a partial fork-out names the thread that failed", async () => {
    const harness = bench({ failOpeners: ["Thread 2"] });

    const report = await runFork({
      channel: "C1",
      depth: 0,
      env: ENV,
      fetchImpl: harness.fetchImpl,
      postMessageImpl: harness.postMessageImpl,
      threads: THREADS,
      updateMessageImpl: harness.updateMessageImpl,
    });

    expect(report.failed[0]?.opener).toContain("Thread 2");
    expect(report.failed[0]?.reason.length).toBeGreaterThan(0);
  });
});
