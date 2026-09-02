import { afterEach, describe, expect, test } from "#src/test-support/effect-test.ts";
import { Schema } from "effect";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "index.ts");

const CHANNEL = "C0TESTPANE";
const THREAD_TS = "1748900000.001900";

const HTTP_ACCEPTED = 202;
const HTTP_BAD_REQUEST = 400;

const DispatchCallSchema = Schema.Struct({
  body: Schema.Unknown,
  path: Schema.String,
});

type DispatchCall = typeof DispatchCallSchema.Type;

const FakeDaemonSchema = Schema.Struct({
  calls: Schema.Array(DispatchCallSchema),
  port: Schema.String,
});

type FakeDaemon = typeof FakeDaemonSchema.Type;

const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.stop(true);
  }
});

const fakeDaemon = (
  reply: () => Response = () => new Response("", { status: HTTP_ACCEPTED })
): FakeDaemon => {
  const calls: DispatchCall[] = [];
  const server = Bun.serve({
    fetch: async (request) => {
      calls.push({
        body: await request.json().catch(() => null),
        path: new URL(request.url).pathname,
      });
      return reply();
    },
    port: 0,
  });
  servers.push(server);
  return {
    calls,
    port: String(server.port),
  };
};

const RunResultSchema = Schema.Struct({
  code: Schema.Number,
  stderr: Schema.String,
  stdout: Schema.String,
});

type RunResult = typeof RunResultSchema.Type;

const run = async (input: {
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly port: string;
}): Promise<RunResult> => {
  const env: Record<string, string | undefined> = {
    ORI_RUNTIME_PORT: input.port,
    PATH: Bun.env.PATH,
    SLACK_USER_ID: "U0READER",
    ...input.env,
  };
  const child = Bun.spawn([process.execPath, SCRIPT, ...input.args], {
    env: Object.fromEntries(
      Object.entries(env).filter(([, value]) => value !== undefined)
    ),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    code,
    stderr,
    stdout,
  };
};

const CONTINUE = [
  "continue",
  "--channel",
  CHANNEL,
  "--thread-ts",
  THREAD_TS,
  "--prompt",
  "read the logs and report back",
];

describe("continuing an open thread", () => {
  test("enqueues the turn and exits zero without printing anything", async () => {
    const daemon = fakeDaemon();

    const result = await run({
      args: CONTINUE,
      port: daemon.port,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(daemon.calls).toHaveLength(1);
    expect(daemon.calls[0]?.path).toBe("/slack/thread/dispatch");
    expect(daemon.calls[0]?.body).toEqual({
      channel: CHANNEL,
      message: "read the logs and report back",
      spawn_thread_depth: 1,
      thread_ts: THREAD_TS,
      user_id: "U0READER",
    });
  });

  test("treats the legacy flag-only form as a continuation", async () => {
    const daemon = fakeDaemon();

    const result = await run({
      args: CONTINUE.slice(1),
      port: daemon.port,
    });

    expect(result.code).toBe(0);
    expect(daemon.calls).toHaveLength(1);
  });

  test("carries the depth it was launched at into the child", async () => {
    const daemon = fakeDaemon();

    await run({
      args: CONTINUE,
      env: { SPAWN_THREAD_DEPTH: "1" },
      port: daemon.port,
    });

    expect(daemon.calls[0]?.body).toMatchObject({
      spawn_thread_depth: 2,
    });
  });

  test("reports the route's refusal instead of exiting zero", async () => {
    const daemon = fakeDaemon(
      () =>
        new Response("thread is retired", {
          status: HTTP_BAD_REQUEST,
        })
    );

    const result = await run({
      args: CONTINUE,
      port: daemon.port,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("thread is retired");
  });
});

describe("the recursion guard", () => {
  test("refuses at the maximum depth before any dispatch", async () => {
    const daemon = fakeDaemon();

    const result = await run({
      args: CONTINUE,
      env: { SPAWN_THREAD_DEPTH: "3" },
      port: daemon.port,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("max depth");
    expect(daemon.calls).toBeEmpty();
  });

  test("refuses a depth that is not a whole number", async () => {
    const daemon = fakeDaemon();

    const result = await run({
      args: CONTINUE,
      env: { SPAWN_THREAD_DEPTH: "2abc" },
      port: daemon.port,
    });

    expect(result.code).toBe(1);
    expect(daemon.calls).toBeEmpty();
  });
});

describe("arguments it cannot act on", () => {
  test("a continuation with no thread prints usage and dispatches nothing", async () => {
    const daemon = fakeDaemon();

    const result = await run({
      args: ["continue", "--channel", CHANNEL, "--prompt", "go"],
      port: daemon.port,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Usage:");
    expect(daemon.calls).toBeEmpty();
  });

  test("a new thread with no opener prints usage before touching Slack", async () => {
    const daemon = fakeDaemon();

    const result = await run({
      args: ["new", "--channel", CHANNEL, "--prompt", "go"],
      port: daemon.port,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--opener");
    expect(daemon.calls).toBeEmpty();
  });
});