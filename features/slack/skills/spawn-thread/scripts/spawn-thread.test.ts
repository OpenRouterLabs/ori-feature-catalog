import { describe, expect, test } from "#src/test-support/effect-test.ts";
import { Result } from "effect";

import type { FetchLike } from "./spawn-thread.ts";

import {
  DEFAULT_HTTP_PORT,
  MAX_SPAWN_DEPTH,
  Subcommand,
  checkDepth,
  dispatchToRunloop,
  parseArgs,
  resolveHttpPort,
  runContinue,
} from "./spawn-thread.ts";

interface Call {
  readonly body: Record<string, unknown>;
  readonly url: string;
}

const recording = (
  calls: Call[],
  reply: () => Response = () => new Response("", { status: 202 })
): FetchLike =>
  (url, init) => {
    calls.push({
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      url: String(url),
    });
    return Promise.resolve(reply());
  };

describe("parseArgs", () => {
  test("reads the subcommand only from the first token", () => {
    expect(parseArgs(["new", "--channel", "C1"]).subcommand).toBe(
      Subcommand.New
    );
    expect(parseArgs(["--channel", "C1", "new"]).subcommand).toBeUndefined();
  });

  test("takes channel and thread-ts from long or short flags", () => {
    expect(
      parseArgs(["continue", "-c", "C1", "-t", "1700.1", "-p", "do it"])
    ).toEqual({
      channel: "C1",
      prompt: "do it",
      subcommand: Subcommand.Continue,
      threadTs: "1700.1",
    });
  });

  test("--prompt is terminal and keeps the whole task as one string", () => {
    expect(
      parseArgs(["--channel", "C1", "--prompt", "read", "the", "logs"]).prompt
    ).toBe("read the logs");
  });

  test("--prompt swallows tokens that look like flags after it", () => {
    const parsed = parseArgs([
      "--prompt",
      "check --channel C9 for errors",
      "extra",
    ]);

    expect(parsed.prompt).toBe("check --channel C9 for errors extra");
    expect(parsed.channel).toBeUndefined();
  });

  test("--opener stops at --prompt so the two never merge", () => {
    const parsed = parseArgs([
      "new",
      "--channel",
      "C1",
      "--opener",
      "Digging",
      "into",
      "the",
      "outage",
      "--prompt",
      "find the cause",
    ]);

    expect(parsed.opener).toBe("Digging into the outage");
    expect(parsed.prompt).toBe("find the cause");
  });

  test("bare words become the prompt when no --prompt was passed", () => {
    expect(parseArgs(["-c", "C1", "-t", "1700.1", "do", "it"]).prompt).toBe(
      "do it"
    );
  });

  test("a value flag with nothing after it is not treated as a value", () => {
    expect(parseArgs(["--channel"]).channel).toBeUndefined();
    expect(parseArgs(["--channel", "--prompt", "hi"]).channel).toBeUndefined();
  });
});

describe("checkDepth", () => {
  test("an unset depth is the top of the chain", () => {
    expect(checkDepth(undefined)).toEqual(Result.succeed(0));
  });

  test("allows every level below the maximum", () => {
    for (let depth = 0; depth < MAX_SPAWN_DEPTH; depth += 1) {
      expect(Result.isSuccess(checkDepth(String(depth)))).toBe(true);
    }
  });

  test("refuses at the maximum rather than one spawn past it", () => {
    const result = checkDepth(String(MAX_SPAWN_DEPTH));

    expect(Result.isFailure(result)).toBe(true);
    expect(Result.isFailure(result) && result.failure.message).toContain(
      `max depth (${MAX_SPAWN_DEPTH})`
    );
  });

  test("a half-numeric depth is refused, not parsed as its prefix", () => {
    expect(Result.isFailure(checkDepth("2abc"))).toBe(true);
    expect(Result.isFailure(checkDepth("1.5"))).toBe(true);
    expect(Result.isFailure(checkDepth("-1"))).toBe(true);
  });
});

describe("resolveHttpPort", () => {
  test("defaults to the daemon's port when the env says nothing", () => {
    expect(resolveHttpPort({})).toBe(DEFAULT_HTTP_PORT);
    expect(resolveHttpPort({ ORI_RUNTIME_PORT: "" })).toBe(DEFAULT_HTTP_PORT);
  });

  test("uses a valid port from the env", () => {
    expect(resolveHttpPort({ ORI_RUNTIME_PORT: "4000" })).toBe(4000);
  });

  test("falls back rather than building an unusable URL", () => {
    expect(resolveHttpPort({ ORI_RUNTIME_PORT: "abc" })).toBe(
      DEFAULT_HTTP_PORT
    );
    expect(resolveHttpPort({ ORI_RUNTIME_PORT: "0" })).toBe(DEFAULT_HTTP_PORT);
    expect(resolveHttpPort({ ORI_RUNTIME_PORT: "70000" })).toBe(
      DEFAULT_HTTP_PORT
    );
  });
});

describe("dispatchToRunloop", () => {
  test("posts the turn to the loopback dispatch route", async () => {
    const calls: Call[] = [];

    const result = await dispatchToRunloop({
      channel: "C1",
      depth: 0,
      env: {
        ORI_RUNTIME_PORT: "4000",
        SLACK_USER_ID: "U1",
      },
      fetchImpl: recording(calls),
      message: "read the logs",
      threadTs: "1700.1",
    });

    expect(Result.isSuccess(result)).toBe(true);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4000/slack/thread/dispatch");
    expect(calls[0]?.body).toEqual({
      channel: "C1",
      message: "read the logs",
      spawn_thread_depth: 1,
      thread_ts: "1700.1",
      user_id: "U1",
    });
  });

  test("hands the child a depth one greater than its own", async () => {
    const calls: Call[] = [];

    await dispatchToRunloop({
      channel: "C1",
      depth: 1,
      env: {},
      fetchImpl: recording(calls),
      message: "go",
      threadTs: "1700.1",
    });

    expect(calls[0]?.body.spawn_thread_depth).toBe(2);
  });

  test("never invents a user for an unattributed spawn", async () => {
    const calls: Call[] = [];

    await dispatchToRunloop({
      channel: "C1",
      depth: 0,
      env: {},
      fetchImpl: recording(calls),
      message: "go",
      threadTs: "1700.1",
    });

    expect(calls[0]?.body.user_id).toBeUndefined();
  });

  test("reports the route's refusal with its status and body", async () => {
    const result = await dispatchToRunloop({
      channel: "C1",
      depth: 0,
      env: {},
      fetchImpl: () =>
        Promise.resolve(
          new Response("spawn depth 4 exceeds the maximum of 3", {
            status: 400,
          })
        ),
      message: "go",
      threadTs: "1700.1",
    });

    expect(Result.isFailure(result)).toBe(true);
    expect(Result.isFailure(result) && result.failure.message).toBe(
      "dispatch rejected (HTTP 400): spawn depth 4 exceeds the maximum of 3"
    );
  });

  test("still reports the status when the error body cannot be read", async () => {
    const unreadable = new Response("x", { status: 503 });
    Object.defineProperty(unreadable, "text", {
      value: () => Promise.reject(new Error("stream closed")),
    });

    const result = await dispatchToRunloop({
      channel: "C1",
      depth: 0,
      env: {},
      fetchImpl: () => Promise.resolve(unreadable),
      message: "go",
      threadTs: "1700.1",
    });

    expect(Result.isFailure(result) && result.failure.message).toContain(
      "HTTP 503"
    );
    expect(Result.isFailure(result) && result.failure.message).toContain(
      "could not read error body"
    );
  });

  test("an unreachable daemon is a failure, not a rejected promise", async () => {
    const result = await dispatchToRunloop({
      channel: "C1",
      depth: 0,
      env: {},
      fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
      message: "go",
      threadTs: "1700.1",
    });

    expect(Result.isFailure(result) && result.failure.message).toBe(
      "dispatch request failed: ECONNREFUSED"
    );
  });
});

describe("runContinue", () => {
  test("dispatches the prompt into the thread it was given", async () => {
    const calls: Call[] = [];

    const result = await runContinue({
      channel: "C1",
      depth: 0,
      env: {},
      fetchImpl: recording(calls),
      prompt: "keep going",
      threadTs: "1700.1",
    });

    expect(Result.isSuccess(result)).toBe(true);
    expect(calls[0]?.body).toMatchObject({
      message: "keep going",
      thread_ts: "1700.1",
    });
  });
});
