/* oxlint-disable typescript/no-unsafe-type-assertion typescript/no-base-to-string -- fetch stubs stand in for the platform type, and request bodies are inspected as the JSON they are */
import { describe, expect, test } from "#src/test-support/effect-test.ts";

import type { PostImageEnv } from "./post-image.ts";

import { postImage } from "./post-image.ts";

const THREAD: PostImageEnv = {
  ORI_RUNTIME_PORT: "4000",
  SLACK_CHANNEL_ID: "C1",
  SLACK_TEAM_ID: "T1",
  SLACK_THREAD_TS: "1700.1",
};

interface Call {
  readonly body: Record<string, unknown>;
  readonly url: string;
}

const recording = (
  calls: Call[],
  reply: () => Response = () => Response.json({ ok: true })
): typeof globalThis.fetch =>
  ((url: string, init?: RequestInit) => {
    calls.push({
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      url,
    });
    return Promise.resolve(reply());
  }) as unknown as typeof globalThis.fetch;

const refusing = (reply: () => Response): typeof globalThis.fetch =>
  (() => Promise.resolve(reply())) as unknown as typeof globalThis.fetch;

describe("the prompt the model wrote", () => {
  test("is posted to the image route with the thread from env", async () => {
    const calls: Call[] = [];

    const outcome = await postImage({
      env: THREAD,
      fetch: recording(calls),
      prompt: "a lighthouse at dusk",
      title: "Lighthouse",
    });

    expect(outcome).toEqual({ kind: "posted" });
    expect(calls[0]?.url).toBe("http://127.0.0.1:4000/slack/thread/image");
    expect(calls[0]?.body).toEqual({
      channel: "C1",
      prompt: "a lighthouse at dusk",
      team: "T1",
      thread_ts: "1700.1",
      title: "Lighthouse",
    });
  });

  test("is trimmed, so the shell's spacing never reaches the generator", async () => {
    const calls: Call[] = [];

    await postImage({
      env: THREAD,
      fetch: recording(calls),
      prompt: "  a lighthouse at dusk \n",
    });

    expect(calls[0]?.body.prompt).toBe("a lighthouse at dusk");
  });

  test("carries no title key at all when none was given", async () => {
    const calls: Call[] = [];

    await postImage({
      env: THREAD,
      fetch: recording(calls),
      prompt: "a lighthouse at dusk",
    });

    expect(calls[0]?.body).not.toHaveProperty("title");
  });

  test("falls back to the daemon's default port when none is set", async () => {
    const calls: Call[] = [];

    await postImage({
      env: {
        SLACK_CHANNEL_ID: "C1",
        SLACK_THREAD_TS: "1700.1",
      },
      fetch: recording(calls),
      prompt: "a lighthouse at dusk",
    });

    expect(calls[0]?.url).toBe("http://127.0.0.1:3141/slack/thread/image");
  });
});

describe("what it refuses before generating anything", () => {
  test("a blank prompt is a usage error, not an empty generation", async () => {
    let called = false;

    const outcome = await postImage({
      env: THREAD,
      fetch: refusing(() => {
        called = true;
        return Response.json({ ok: true });
      }),
      prompt: "   ",
    });

    expect(outcome).toMatchObject({ kind: "error" });
    expect(outcome.kind === "error" && outcome.message).toContain("usage:");
    expect(called).toBe(false);
  });

  test("a missing prompt is reported before a missing thread", async () => {
    const outcome = await postImage({
      env: {},
      fetch: refusing(() => Response.json({ ok: true })),
      prompt: "",
    });

    expect(outcome.kind === "error" && outcome.message).toContain("usage:");
  });

  test("a blank thread ts reads as absent, not as a thread", async () => {
    const outcome = await postImage({
      env: {
        SLACK_CHANNEL_ID: "C1",
        SLACK_THREAD_TS: "",
      },
      fetch: refusing(() => Response.json({ ok: true })),
      prompt: "a lighthouse at dusk",
    });

    expect(outcome).toMatchObject({ kind: "error" });
    expect(outcome.kind === "error" && outcome.message).toContain(
      "no Slack thread in scope"
    );
  });
});

describe("when the daemon cannot draw it", () => {
  test("the status is reported rather than swallowed as success", async () => {
    const outcome = await postImage({
      env: THREAD,
      fetch: refusing(() => new Response("nope", { status: 500 })),
      prompt: "a lighthouse at dusk",
    });

    expect(outcome).toMatchObject({
      kind: "error",
      message: "500",
    });
  });

  test("a daemon that is not there is reported rather than thrown", async () => {
    const outcome = await postImage({
      env: THREAD,
      fetch: (() =>
        Promise.reject(
          new Error("ECONNREFUSED")
        )) as unknown as typeof globalThis.fetch,
      prompt: "a lighthouse at dusk",
    });

    expect(outcome).toMatchObject({
      kind: "error",
      message: "could not reach the ori daemon",
    });
  });
});
