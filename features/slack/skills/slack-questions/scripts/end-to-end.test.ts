/* oxlint-disable typescript/explicit-function-return-type eslint/max-lines-per-function -- cases read better whole than split */

import { afterEach, describe, expect, test } from "#src/test-support/effect-test.ts";

import { Effect, Schema } from "effect";

import { QuestionnairesMemory } from "#src/interactions/questionnaires.ts";
import { makeQuestionsRoute } from "#src/turn/routes/questions-route.ts";

const SCRIPT = `${import.meta.dir}/index.ts`;

const CHANNEL = "C0TESTPANE";
const THREAD_TS = "1748900000.001900";

const INTRO = "Before I start on the 7 conflicting PRs, two things.";

const QUESTIONS = [
  {
    choices: ["Rebase", "Close"],
    id: "strategy",
    kind: "single",
    prompt: "Rebase them or close them?",
  },
];

const END_YOUR_TURN =
  "Asked. END YOUR TURN now — say what you are blocked on. You will be " +
  "started again on this thread with their answers when they reply.\n";

const DaemonSchema = Schema.Struct({
  bodies: Schema.Array(Schema.Unknown),
  port: Schema.Number,
});

type Daemon = typeof DaemonSchema.Type;

const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.stop(true);
  }
});

const daemon = (
  answer: (request: Request) => Response | Promise<Response> = () =>
    Response.json({
      ask_id: "ask-1",
      ok: true,
    })
): Daemon => {
  const bodies: unknown[] = [];
  const server = Bun.serve({
    fetch: async (request) => {
      const raw = await request.text();
      bodies.push(JSON.parse(raw));
      return await answer(
        new Request(request.url, {
          body: raw,
          headers: request.headers,
          method: request.method,
        })
      );
    },
    port: 0,
  });
  servers.push(server);
  const { port } = server;
  if (port === undefined) {
    throw new Error("the fake daemon never bound a port");
  }
  return {
    bodies,
    port,
  };
};

const routeDaemon = (options: { live?: boolean } = {}): Daemon => {
  const forms = Effect.runSync(QuestionnairesMemory);
  const route = makeQuestionsRoute({
    forms,
    isLive: () => Promise.resolve(options.live ?? true),
    newAskId: () => "ask-1",
    post: () => Promise.resolve("1700.2"),
    workspaceTeamId: "T1",
  });
  return daemon((request) => route(request));
};

const RunResultSchema = Schema.Struct({
  code: Schema.Number,
  stderr: Schema.String,
  stdout: Schema.String,
});

type RunResult = typeof RunResultSchema.Type;

const run = async (input: {
  readonly args?: readonly string[];
  readonly daemon: Daemon;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string;
}): Promise<RunResult> => {
  const env: Record<string, string | undefined> = {
    ORI_RUNTIME_PORT: String(input.daemon.port),
    PATH: Bun.env.PATH,
    SLACK_CHANNEL_ID: CHANNEL,
    SLACK_THREAD_TS: THREAD_TS,
    ...input.env,
  };
  const child = Bun.spawn([process.execPath, SCRIPT, ...(input.args ?? [])], {
    env: Object.fromEntries(
      Object.entries(env).filter(([, value]) => value !== undefined)
    ),
    stderr: "pipe",
    stdin: Buffer.from(input.stdin ?? ""),
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

describe("the questions reach the thread", () => {
  test("a heredoc keeps an apostrophe intact, which a quoted argument cannot", async () => {
    const fake = daemon();
    const prompt = "Delete Ahmed's branch?";

    const result = await run({
      args: [INTRO],
      daemon: fake,
      stdin: `${JSON.stringify([
        {
          id: "branch",
          prompt,
        },
      ])}\n`,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(END_YOUR_TURN);
    expect(fake.bodies).toHaveLength(1);
    expect(fake.bodies[0]).toMatchObject({
      channel: CHANNEL,
      intro: INTRO,
      questions: [
        {
          id: "branch",
          prompt,
        },
      ],
      thread_ts: THREAD_TS,
    });
  });

  test("a JSON array as an argument still works, apostrophes aside", async () => {
    const fake = daemon();

    const result = await run({
      args: [INTRO, JSON.stringify(QUESTIONS)],
      daemon: fake,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(END_YOUR_TURN);
    expect(fake.bodies[0]).toMatchObject({ questions: QUESTIONS });
  });

  test("the thread comes from the environment, never from an argument", async () => {
    const fake = daemon();

    const result = await run({
      args: [INTRO, JSON.stringify(QUESTIONS)],
      daemon: fake,
      env: {
        SLACK_CHANNEL_ID: "C_OTHER",
        SLACK_TEAM_ID: "T9",
        SLACK_THREAD_TS: "1700.9",
      },
    });

    expect(result.code).toBe(0);
    expect(fake.bodies[0]).toMatchObject({
      channel: "C_OTHER",
      team: "T9",
      thread_ts: "1700.9",
    });
  });
});

describe("what the model is told when nothing was asked", () => {
  test("questions that are not JSON exit 1 with the usage, and post nothing", async () => {
    const fake = daemon();

    const result = await run({
      args: [INTRO, "rebase or close?"],
      daemon: fake,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("must be a JSON array");
    expect(result.stderr).toContain("usage: slack-questions");
    expect(fake.bodies).toHaveLength(0);
  });

  test("a JSON object rather than an array is refused the same way", async () => {
    const fake = daemon();

    const result = await run({
      args: [INTRO, JSON.stringify({ id: "one" })],
      daemon: fake,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("must be a JSON array");
    expect(fake.bodies).toHaveLength(0);
  });

  test("a question missing its prompt is refused, not forwarded", async () => {
    const fake = daemon();

    const result = await run({
      args: [INTRO, JSON.stringify([{ id: "one" }])],
      daemon: fake,
    });

    expect(result.code).toBe(1);
    expect(fake.bodies).toHaveLength(0);
  });

  test("a question whose kind is not one Slack renders is refused", async () => {
    const fake = daemon();

    const result = await run({
      args: [
        INTRO,
        JSON.stringify([{ id: "one", kind: "dropdown", prompt: "Which?" }]),
      ],
      daemon: fake,
    });

    expect(result.code).toBe(1);
    expect(fake.bodies).toHaveLength(0);
  });

  test("an empty array exits 1 before the daemon is called at all", async () => {
    const fake = daemon();

    const result = await run({
      args: [INTRO, "[]"],
      daemon: fake,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("at least one question");
    expect(fake.bodies).toHaveLength(0);
  });

  test("no thread in scope names the variables that are missing", async () => {
    const fake = daemon();

    const result = await run({
      args: [INTRO, JSON.stringify(QUESTIONS)],
      daemon: fake,
      env: { SLACK_THREAD_TS: undefined },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("SLACK_THREAD_TS");
    expect(fake.bodies).toHaveLength(0);
  });
});

describe("a refusal from the route", () => {
  test("reaches the model verbatim, because it is written for the model", async () => {
    const twice = [
      {
        id: "strategy",
        prompt: "Rebase them or close them?",
      },
      {
        id: "strategy",
        prompt: "Which one first?",
      },
    ];

    const result = await run({
      args: [INTRO, JSON.stringify(twice)],
      daemon: routeDaemon(),
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      'slack-questions: {"error":"every question needs its own id"}\n'
    );
  });

  test("carries the count when there are more questions than anyone answers", async () => {
    const many = Array.from({ length: 11 }, (_value, index) => ({
      id: `q${index}`,
      prompt: `Question ${index}?`,
    }));

    const result = await run({
      args: [INTRO, JSON.stringify(many)],
      daemon: routeDaemon(),
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("11 questions");
    expect(result.stderr).toContain("max 10");
  });

  test("says the thread has no run rather than pretending it asked", async () => {
    const result = await run({
      args: [INTRO, JSON.stringify(QUESTIONS)],
      daemon: routeDaemon({ live: false }),
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no run is active");
  });

  test("an oversized batch is refused by the route's own cap", async () => {
    const huge = Array.from({ length: 4 }, (_value, index) => ({
      id: `q${index}`,
      prompt: "Which of these should I do first? ".repeat(300),
    }));

    const result = await run({
      args: [INTRO],
      daemon: routeDaemon(),
      stdin: JSON.stringify(huge),
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("payload too large");
  });

  test("a daemon that is not there is reported, not a stack trace", async () => {
    const dead = daemon();
    await servers.splice(0).at(0)?.stop(true);

    const result = await run({
      args: [INTRO, JSON.stringify(QUESTIONS)],
      daemon: dead,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("could not reach the ori daemon");
  });
});

describe("a form the route accepted", () => {
  test("ends the turn: the line is the whole output, and the code is 0", async () => {
    const fake = routeDaemon();

    const result = await run({
      args: [INTRO, JSON.stringify(QUESTIONS)],
      daemon: fake,
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(END_YOUR_TURN);
    expect(result.stdout).toContain("END YOUR TURN");
  });
});