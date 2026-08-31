/* oxlint-disable typescript/no-unsafe-type-assertion -- test doubles stand in for Slack SDK and fetch shapes */

import { Option, Result } from "effect";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { runCarry } from "./carry.ts";

const ENV = {
  ORI_HTTP_PORT: "7070",
  SLACK_CHANNEL_ID: "C1",
  SLACK_THREAD_TS: "1700.1",
};

interface Posted {
  readonly channel: string;
  readonly text: string;
  readonly threadTs: string | undefined;
}

const harness = (
  options: { readonly carryStatus?: number } = {}
): {
  readonly fetchImpl: typeof fetch;
  readonly posts: Posted[];
  readonly postMessageImpl: never;
  readonly updateMessageImpl: never;
} => {
  const posts: Posted[] = [];
  let nextTs = 100;
  return {
    fetchImpl: ((): Promise<Response> => {
      const status = options.carryStatus ?? 200;
      return Promise.resolve(
        new Response(JSON.stringify({ sessionId: "sess-live" }), { status })
      );
    }) as unknown as typeof fetch,
    postMessageImpl: ((input: Posted): Promise<
      Result.Result<Option.Option<{ ts: string }>, Error>
    > => {
      posts.push(input);
      nextTs += 1;
      return Promise.resolve(
        Result.succeed(Option.some({ ts: `18${nextTs}.5` }))
      );
    }) as never,
    posts,
    updateMessageImpl: ((): Promise<Result.Result<void, Error>> =>
      Promise.resolve(Result.void)) as never,
  };
};

describe("carrying from the skill", () => {
  test("refuses when there is no thread in scope", async () => {
    const result = await runCarry({
      env: {},
      opener: "Continuing here",
    });

    expect(Result.isFailure(result)).toBe(true);
  });

  test("opens the new thread and reports where the session went", async () => {
    const bench = harness();

    const result = await runCarry({
      env: ENV,
      fetchImpl: bench.fetchImpl,
      opener: "Continuing here",
      postMessageImpl: bench.postMessageImpl,
      updateMessageImpl: bench.updateMessageImpl,
    });

    expect(Result.isSuccess(result)).toBe(true);
    expect(Result.isSuccess(result) && result.success.sessionId).toBe(
      "sess-live"
    );
  });

  test("the old thread is told where the conversation went", async () => {
    const bench = harness();

    await runCarry({
      env: ENV,
      fetchImpl: bench.fetchImpl,
      opener: "Continuing here",
      postMessageImpl: bench.postMessageImpl,
      updateMessageImpl: bench.updateMessageImpl,
    });

    const intoOrigin = bench.posts.filter(
      (post) => post.threadTs === ENV.SLACK_THREAD_TS
    );
    expect(intoOrigin.some((post) => post.text.includes("Continued in"))).toBe(
      true
    );
    expect(intoOrigin.some((post) => post.text.includes("muted"))).toBe(true);
  });

  test("a refused carry reports into the thread the user is watching", async () => {
    const bench = harness({ carryStatus: 409 });

    const result = await runCarry({
      env: ENV,
      fetchImpl: bench.fetchImpl,
      opener: "Continuing here",
      postMessageImpl: bench.postMessageImpl,
      updateMessageImpl: bench.updateMessageImpl,
    });

    expect(Result.isFailure(result)).toBe(true);
    const intoOrigin = bench.posts.filter(
      (post) => post.threadTs === ENV.SLACK_THREAD_TS
    );
    expect(
      intoOrigin.some((post) => post.text.includes("Could not move"))
    ).toBe(true);
  });

  test("a refused carry does not claim the conversation moved", async () => {
    const bench = harness({ carryStatus: 422 });

    await runCarry({
      env: ENV,
      fetchImpl: bench.fetchImpl,
      opener: "Continuing here",
      postMessageImpl: bench.postMessageImpl,
      updateMessageImpl: bench.updateMessageImpl,
    });

    expect(
      bench.posts.some((post) => post.text.includes("Continued in"))
    ).toBe(false);
  });
});
