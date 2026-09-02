/* oxlint-disable typescript/no-unsafe-type-assertion typescript/no-base-to-string -- fetch stubs stand in for the platform type, and request bodies are inspected as the JSON they are */
import { describe, expect, test } from "#src/test-support/effect-test.ts";
import { Schema } from "effect";

import type { PostChartEnv } from "./post-chart.ts";

import { postChart } from "./post-chart.ts";

const THREAD: PostChartEnv = {
  ORI_RUNTIME_PORT: "4000",
  SLACK_CHANNEL_ID: "C1",
  SLACK_TEAM_ID: "T1",
  SLACK_THREAD_TS: "1700.1",
};

const SPEC = JSON.stringify({
  kind: "bar",
  series: [1, 2, 3],
});

const CallSchema = Schema.Struct({
  body: Schema.Unknown,
  url: Schema.String,
});

type Call = typeof CallSchema.Type;

const recording = (
  calls: Call[],
  reply: () => Response = () => Response.json({ ok: true })
): typeof globalThis.fetch =>
  ((url: string, init?: RequestInit) => {
    calls.push({
      body: JSON.parse(String(init?.body)),
      url,
    });
    return Promise.resolve(reply());
  }) as unknown as typeof globalThis.fetch;

const refusing = (reply: () => Response): typeof globalThis.fetch =>
  (() => Promise.resolve(reply())) as unknown as typeof globalThis.fetch;

describe("the spec the model wrote", () => {
  test("is posted to the daemon's chart route with the thread from env", async () => {
    const calls: Call[] = [];

    const outcome = await postChart({
      env: THREAD,
      fetch: recording(calls),
      spec: SPEC,
    });

    expect(outcome).toEqual({ kind: "posted" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4000/slack/thread/chart");
    expect(calls[0]?.body).toEqual({
      channel: "C1",
      kind: "bar",
      series: [1, 2, 3],
      team: "T1",
      thread_ts: "1700.1",
    });
  });

  test("cannot redirect the chart by naming a channel of its own", async () => {
    const calls: Call[] = [];

    await postChart({
      env: THREAD,
      fetch: recording(calls),
      spec: JSON.stringify({
        channel: "C-SOMEWHERE-ELSE",
        thread_ts: "9999.9",
      }),
    });

    expect(calls[0]?.body).toMatchObject({
      channel: "C1",
      thread_ts: "1700.1",
    });
  });

  test("falls back to the daemon's default port when none is set", async () => {
    const calls: Call[] = [];

    await postChart({
      env: {
        SLACK_CHANNEL_ID: "C1",
        SLACK_THREAD_TS: "1700.1",
      },
      fetch: recording(calls),
      spec: SPEC,
    });

    expect(calls[0]?.url).toBe("http://127.0.0.1:3141/slack/thread/chart");
  });
});

describe("what it refuses before calling anything", () => {
  test("a spec that is not JSON is a usage error, not a crash", async () => {
    let called = false;

    const outcome = await postChart({
      env: THREAD,
      fetch: recording([], () => {
        called = true;
        return Response.json({ ok: true });
      }),
      spec: "kind: bar",
    });

    expect(outcome).toMatchObject({
      kind: "error",
      message: "the spec must be JSON",
    });
    expect(called).toBe(false);
  });

  test("JSON that is not an object cannot carry a chart", async () => {
    const outcome = await postChart({
      env: THREAD,
      fetch: refusing(() => Response.json({ ok: true })),
      spec: "3",
    });

    expect(outcome).toMatchObject({
      kind: "error",
      message: "the spec must be a JSON object",
    });
  });

  test("no thread in scope names the variables that are missing", async () => {
    const outcome = await postChart({
      env: {
        SLACK_CHANNEL_ID: "C1",
        SLACK_THREAD_TS: "",
      },
      fetch: refusing(() => Response.json({ ok: true })),
      spec: SPEC,
    });

    expect(outcome).toMatchObject({ kind: "error" });
    expect(outcome.kind === "error" && outcome.message).toContain(
      "SLACK_CHANNEL_ID / SLACK_THREAD_TS"
    );
  });
});

describe("what the daemon said when it refused", () => {
  test("is reported in the route's own words, not as a bare status", async () => {
    const outcome = await postChart({
      env: THREAD,
      fetch: refusing(() =>
        Response.json({ error: "the chart spec has no series" }, { status: 400 })
      ),
      spec: SPEC,
    });

    expect(outcome).toMatchObject({
      kind: "error",
      message: "400 — the chart spec has no series",
    });
  });

  test("degrades to the status when the body explains nothing", async () => {
    const outcome = await postChart({
      env: THREAD,
      fetch: refusing(() => new Response("<html>gateway</html>", { status: 502 })),
      spec: SPEC,
    });

    expect(outcome).toMatchObject({
      kind: "error",
      message: "502",
    });
  });

  test("an empty error string is treated as no explanation at all", async () => {
    const outcome = await postChart({
      env: THREAD,
      fetch: refusing(() => Response.json({ error: "" }, { status: 500 })),
      spec: SPEC,
    });

    expect(outcome).toMatchObject({
      kind: "error",
      message: "500",
    });
  });

  test("a daemon that is not there is reported rather than thrown", async () => {
    const outcome = await postChart({
      env: THREAD,
      fetch: (() =>
        Promise.reject(
          new Error("ECONNREFUSED")
        )) as unknown as typeof globalThis.fetch,
      spec: SPEC,
    });

    expect(outcome).toMatchObject({
      kind: "error",
      message: "could not reach the ori daemon",
    });
  });
});