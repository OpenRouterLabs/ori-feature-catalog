import { afterEach, describe, expect, test } from "#src/test-support/index.ts";
import { Schema } from "effect";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "index.ts");

const CHANNEL = "C0TESTPANE";
const THREAD_TS = "1748900000.001900";
const TEAM = "T0WORKSPACE";

const QUESTION = "Rebase or close the 7 conflicting PRs?";

const HTTP_TIMEOUT = 408;
const HTTP_BAD_GATEWAY = 502;

const AskCallSchema = Schema.Struct({
  body: Schema.Unknown,
  path: Schema.String,
});

type AskCall = typeof AskCallSchema.Type;

const FakeDaemonSchema = Schema.Struct({
  calls: Schema.Array(AskCallSchema),
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
  reply: () => Response = () =>
    Response.json({
      answer: "rebase",
      ok: true,
    })
): FakeDaemon => {
  const calls: AskCall[] = [];
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

const deadPort = async (): Promise<string> => {
  const server = Bun.serve({
    fetch: () => new Response("no"),
    port: 0,
  });
  const port = String(server.port);
  await server.stop(true);
  return port;
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
    SLACK_CHANNEL_ID: CHANNEL,
    SLACK_TEAM_ID: TEAM,
    SLACK_THREAD_TS: THREAD_TS,
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

const ASKED = [
  QUESTION,
  "--choice",
  "rebase=Rebase them",
  "--choice",
  "close=Close them",
];

describe("an answered blocker", () => {
  test("prints the id to stdout and nothing else", async () => {
    const daemon = fakeDaemon();

    const result = await run({
      args: ASKED,
      port: daemon.port,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("rebase\n");
  });

  test("sends the thread it was launched into and the choices it was given", async () => {
    const daemon = fakeDaemon();

    await run({
      args: ASKED,
      port: daemon.port,
    });

    expect(daemon.calls).toHaveLength(1);
    expect(daemon.calls[0]?.path).toBe("/slack/thread/ask");
    expect(daemon.calls[0]?.body).toEqual({
      channel: CHANNEL,
      choices: [
        {
          id: "rebase",
          label: "Rebase them",
        },
        {
          id: "close",
          label: "Close them",
        },
      ],
      question: QUESTION,
      team: TEAM,
      thread_ts: THREAD_TS,
    });
  });

  test("takes the question from the words around the flags", async () => {
    const daemon = fakeDaemon();

    const result = await run({
      args: ["--choice", "rebase=Rebase them", "Rebase", "or", "close?"],
      port: daemon.port,
    });

    expect(result.code).toBe(0);
    expect(daemon.calls[0]?.body).toMatchObject({
      question: "Rebase or close?",
    });
  });
});

describe("a blocker nobody answered", () => {
  test("is an outcome on stdout and a zero exit, not a failed run", async () => {
    const daemon = fakeDaemon(() =>
      Response.json({ error: "nobody answered" }, { status: HTTP_TIMEOUT })
    );

    const result = await run({
      args: ASKED,
      port: daemon.port,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("unanswered\n");
    expect(result.stderr).toContain("decide for yourself");
  });
});

describe("a blocker the run cannot ask", () => {
  test("with a malformed --choice stops rather than dropping a button", async () => {
    const daemon = fakeDaemon();

    const result = await run({
      args: [QUESTION, "--choice", "=Rebase them"],
      port: daemon.port,
    });

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(daemon.calls).toHaveLength(0);
    expect(result.stderr).toContain("=Rebase them");
    expect(result.stderr).toContain("--choice");
  });

  test("with no thread in scope names the variable that is missing", async () => {
    const daemon = fakeDaemon();

    const result = await run({
      args: ASKED,
      env: { SLACK_THREAD_TS: undefined },
      port: daemon.port,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(daemon.calls).toHaveLength(0);
    expect(result.stderr).toContain("SLACK_THREAD_TS");
  });

  test("with no daemon listening says so instead of hanging", async () => {
    const result = await run({
      args: ASKED,
      port: await deadPort(),
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("daemon");
  });

  test("with no question at all prints the usage line", async () => {
    const daemon = fakeDaemon();

    const result = await run({
      args: ["--choice", "rebase=Rebase them"],
      port: daemon.port,
    });

    expect(result.code).toBe(1);
    expect(daemon.calls).toHaveLength(0);
    expect(result.stderr).toContain("usage:");
  });

  test("that Slack refused is a failure the agent can see", async () => {
    const daemon = fakeDaemon(() =>
      Response.json(
        { error: "the blocker could not be posted" },
        { status: HTTP_BAD_GATEWAY }
      )
    );

    const result = await run({
      args: ASKED,
      port: daemon.port,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("could not be posted");
  });
});