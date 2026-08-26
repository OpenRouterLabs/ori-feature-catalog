/**
 * end-to-end.test.ts — the real CLI, as a real process, against a fake daemon.
 *
 * `spawn-thread.test.ts` drives the parser and the dispatch call directly, so
 * the composition root — argv slicing, the depth read from env, which failure
 * prints usage and which prints a reason, and the exit code the agent branches
 * on — had never run. A spawn is fire-and-forget: the agent's only signal that
 * a thread was opened is the exit code, so a failure reported as success is a
 * task nobody is working on.
 *
 * Only the `continue` path reaches the daemon here; `new` posts to Slack first
 * and has no token in this environment, so it is exercised up to the argument
 * check it fails.
 */

import { afterEach, describe, expect, test } from "#src/test-support/effect-test.ts";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "index.ts");

const CHANNEL = "C0TESTPANE";
const THREAD_TS = "1748900000.001900";

const HTTP_ACCEPTED = 202;
const HTTP_BAD_REQUEST = 400;

interface DispatchCall {
  readonly body: unknown;
  readonly path: string;
}

interface FakeDaemon {
  readonly calls: readonly DispatchCall[];
  readonly port: string;
}

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

interface RunResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

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
    // Fire and forget: the skill does not wait for the run, so anything on
    // stdout would be mistaken for the run's answer.
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
    // A run that has already been spawned three deep is what a runaway looks
    // like; the check happens before argv is even parsed.
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
    // `new` posts the opener itself, so an argument check that ran after the
    // post would leave a half-opened thread behind.
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
